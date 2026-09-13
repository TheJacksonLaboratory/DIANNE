"""XiyueWang CTransPath loader (Swin-Tiny with a custom convolutional stem)."""
import torch
import torch.nn as nn
from torchvision import transforms
import openslide
import numpy as np
import PIL
from concurrent.futures import ThreadPoolExecutor
from tqdm import tqdm
import pandas as pd

def identity_postprocess(features):
    """No-op: the model's forward_fn already returns (batch, num_features)."""
    return features

def build_normalizer(normalization, size=224):
    return transforms.Compose([
        transforms.Resize(size),
        transforms.ToTensor(),
        transforms.Normalize(mean=(0.485, 0.456, 0.406), std=(0.229, 0.224, 0.225)),
    ])

def load(model_path, destination, **kwargs):
    import timm  # local import: avoid clashing with mocov3's `vits` module
    from timm.models.layers.helpers import to_2tuple

    class ConvStem(nn.Module):
        def __init__(self, img_size=224, patch_size=4, in_chans=3, embed_dim=768,
                     norm_layer=None, flatten=True):
            super().__init__()

            assert patch_size == 4
            assert embed_dim % 8 == 0

            img_size = to_2tuple(img_size)
            patch_size = to_2tuple(patch_size)
            self.img_size = img_size
            self.patch_size = patch_size
            self.grid_size = (img_size[0] // patch_size[0], img_size[1] // patch_size[1])
            self.num_patches = self.grid_size[0] * self.grid_size[1]
            self.flatten = flatten

            stem = []
            input_dim, output_dim = 3, embed_dim // 8
            for _ in range(2):
                stem.append(nn.Conv2d(input_dim, output_dim, kernel_size=3, stride=2, padding=1, bias=False))
                stem.append(nn.BatchNorm2d(output_dim))
                stem.append(nn.ReLU(inplace=True))
                input_dim = output_dim
                output_dim *= 2
            stem.append(nn.Conv2d(input_dim, embed_dim, kernel_size=1))
            self.proj = nn.Sequential(*stem)
            self.norm = norm_layer(embed_dim) if norm_layer else nn.Identity()

        def forward(self, x):
            B, C, H, W = x.shape
            assert H == self.img_size[0] and W == self.img_size[1], \
                f"Input image size ({H}*{W}) doesn't match model ({self.img_size[0]}*{self.img_size[1]})."
            x = self.proj(x)
            if self.flatten:
                x = x.flatten(2).transpose(1, 2)  # BCHW -> BNC
            x = self.norm(x)
            return x

    model = timm.create_model('swin_tiny_patch4_window7_224', embed_layer=ConvStem, pretrained=False)
    model.head = nn.Identity()
    model.load_state_dict(torch.load(model_path)['model'], strict=True)
    model.to(destination)
    model.eval()

    return {
        'model': model,
        'transform': build_normalizer('imagenet'),
        'forward_fn': lambda m, batch: m(batch),
        'postprocess_fn': identity_postprocess,
    }

def load_model(model_name, model_path):
    destination = "cuda" if torch.cuda.is_available() else "cpu"
    result = load(model_path, destination)
    return (result['model'], destination, result['transform'],
            result['forward_fn'], result.get('postprocess_fn'))

def read_tile(slide, pos, row_idx, ts=224):
    """Read and (optionally) downsample a single tile centered on a spot. Returns np array or None."""
    cy = pos.iloc[row_idx]['pxl_row_in_wsi']
    cx = pos.iloc[row_idx]['pxl_col_in_wsi']

    img = np.array(slide.read_region(
        (int(cx - ts / 2), int(cy - ts / 2)), 0, (int(ts), int(ts))).convert('RGB'))

    return img

def _try_read_tile(task):
    """Wrapper so a bad/out-of-range row never kills the thread pool."""
    slide, pos, row_idx, ts = task
    try:
        return read_tile(slide, pos, row_idx, ts)
    except Exception:
        return None

def quantize_fixed(arr: np.ndarray, val_range=2.0, dtype=np.int8) -> np.ndarray:
    """Map values in [-val_range, val_range] to int8 [-127, 127]."""
    scale = val_range / np.iinfo(dtype).max
    clipped = np.clip(arr, -val_range, val_range)
    q = np.round(clipped / scale).astype(dtype)
    return q

def extract_features(slide, pos, model, destination, ts,
                      batch_size, num_batches, transform, forward_fn, postprocess_fn,
                      num_workers=8, progress_cb=None):
    features = []
    num_images = len(pos)
    with ThreadPoolExecutor(max_workers=num_workers) as executor:
        for ibatch in tqdm(range(num_batches)):
            start = ibatch * batch_size
            stop = min(start + batch_size, num_images)
            tasks = ((slide, pos, row_idx, ts) for row_idx in range(start, stop))
            images = list(executor.map(_try_read_tile, tasks))

            n_failed = sum(im is None for im in images)
            if n_failed:
                print(f'Warning: {n_failed} tile(s) failed to read in batch {ibatch}; '
                      'substituting blank tiles to keep feature rows aligned with pos')
            images = [im if im is not None else np.zeros((ts, ts, 3), dtype=np.uint8)
                      for im in images]

            if len(images) > 0:
                batch = torch.stack([transform(PIL.Image.fromarray(im)) for im in images], 0)
                if destination == 'cuda':
                    batch = batch.to(destination, non_blocking=True)
                with torch.inference_mode():
                    features_ = model.norm(model.layers(model.patch_embed(batch))).cpu().numpy()
                    Bn, N, C = features_.shape
                    h_, w_ = 7, 7
                    features_ = features_.reshape(Bn, h_, w_, C).transpose(0, 3, 1, 2)
                    features_ = quantize_fixed(features_)
                    features.append(features_)
            if progress_cb:
                progress_cb(ibatch + 1, num_batches)
    return np.vstack(features)

def extract(df_grid, wsi_file, ts=224, num_workers=8, batch_size=512, progress_cb=None):
    model, destination, transform, forward_fn, postprocess_fn = load_model(
        "ctranspath", "/TransPath/ctranspath.pth")

    num_images = len(df_grid)
    num_batches = int(np.ceil(num_images / batch_size))

    slide = openslide.open_slide(wsi_file)

    features = extract_features(slide, df_grid, model, destination, ts,
                                 batch_size, num_batches, transform, forward_fn,
                                 postprocess_fn, num_workers=num_workers, progress_cb=progress_cb)
    features = features.transpose(0, 2, 3, 1).reshape(-1, features.shape[1])
    cols = [f'feat_CTransPath_{i}' for i in range(features.shape[1])]
    return pd.DataFrame(features, columns=cols)

if __name__ == "__main__":

    img_path = f'{dataPath}/{sample}/image.ome.tiff'
    df_grid = pd.read_csv(f'{os.path.dirname(img_path)}/features/false-1-ctranspath_features.tsv.gz', index_col=0)
    df = extract(df_grid[['pxl_row_in_wsi', 'pxl_col_in_wsi']], img_path, ts=224, num_workers=16, batch_size=512)
    df.to_parquet(f'.dianne_annotations/features/false-1-ctranspath_features.parquet')

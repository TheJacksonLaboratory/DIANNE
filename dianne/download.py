import os
import urllib.request
import zipfile

def downloadZIPFromZenodo(targetDir, url, file, extract=True):
    
    """Download the dataset from Zenodo and extracts it to the specified directory."""

    assert file.endswith('.zip'), "The file to download must be a ZIP archive."
    fullTargetPath = os.path.join(targetDir, file[:-4])
    if not os.path.isdir(fullTargetPath):
        def reporthook(a, b, c):
            print(f"\rDownloading: {(a * b) // 1024**2} MB", end='')
        urllib.request.urlretrieve(url + file, file, reporthook)
        print(f"\nDownloaded file into '{targetDir}'.")
        os.makedirs(targetDir, exist_ok=True)
        if extract:
            with zipfile.ZipFile(file, 'r') as zip_ref:
                zip_ref.extractall(targetDir)
            os.remove(file)
            print(f"Extracted dataset into '{targetDir}'.")
    else:
        print(f"Data '{targetDir}' already exists. Skipping download.")
    return

def downloadFromZenodo(targetDir, url, zip_file='dataset.zip'):
    
    """Download the dataset from Zenodo and extracts it to the specified directory."""

    if not os.path.isdir(targetDir):
        def reporthook(a, b, c):
            print(f"\rDownloading: {(a * b) // 1024**2} MB", end='')
        urllib.request.urlretrieve(url, zip_file, reporthook)
        print()
        os.makedirs(targetDir, exist_ok=True)
        with zipfile.ZipFile(zip_file, 'r') as zip_ref:
            zip_ref.extractall(targetDir)
        os.remove(zip_file)
        print(f"Downloaded and extracted dataset into '{targetDir}'.")
    else:
        print(f"Directory '{targetDir}' already exists. Skipping download.")
    return

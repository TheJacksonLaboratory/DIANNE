
from vitessce import VitessceConfig, Component as cm, OmeTiffWrapper, MultiImageWrapper, hconcat

def displayMaskOnHE(f1, f2, schema_version='1.0.17', configName='Test', use_physical_size_scaling=False,
                    datasetName='Test', name1='H&E', name2='Mask', widths=[6, 2], address=None, height=900):

    """Images in f1 and f2 must have the same dimensions.
    The first image is the H&E image and the second image is the mask.    
    
    Parameters
    ----------
    f1 : str
        Path to the first image (H&E).

    f2 : str
        Path to the second image (mask).

    schema_version : str, optional
        Vitessce schema version, by default '1.0.17'.

    configName : str, optional
        Name of the Vitessce configuration, by default 'Test'.

    use_physical_size_scaling : bool, optional
        Whether to use physical size scaling, by default False.

    datasetName : str, optional
        Name of the dataset, by default 'Test'.
    
    name1 : str, optional
        Name of the first image, by default 'H&E'.

    name2 : str, optional
        Name of the second image, by default 'Mask'.

    widths : list, optional
        List of widths for the layout, by default [6, 2].
        Numbers are in the range from 0 to 12.

    address : str, optional
        Address for the Vitessce display, by default None.

    height : int, optional
        Height of the display, by default 900.

    Returns
    -------
    VitessceConfig
        Configured Vitessce widget.
    """
    
    wrapper1 = OmeTiffWrapper(img_path=f1, name=name1)
    wrapper2 = OmeTiffWrapper(img_path=f2, is_bitmask=True, name=name2)
    
    vc = VitessceConfig(schema_version=schema_version, name=configName)
    
    dataset = vc.add_dataset(name=datasetName).add_object(
        MultiImageWrapper(
            image_wrappers=[wrapper1, wrapper2],
            use_physical_size_scaling=use_physical_size_scaling,))
    
    spatial = vc.add_view(cm.SPATIAL, dataset=dataset, h=200)
    
    lc = vc.add_view(cm.LAYER_CONTROLLER, dataset=dataset).set_props(
        disableChannelsIfRgbDetected=True)
    
    vc.layout(hconcat(spatial, lc, split=widths))

    return vc.display(proxy=True, host_name=address, height=height)

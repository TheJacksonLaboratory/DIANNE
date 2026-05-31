import numpy as np
from scipy.interpolate import griddata
from scipy.spatial import KDTree

def interpolate_points(x_coords, y_coords, values, multiplier=16):
    """
    Interpolate sparse points to create a denser set of points.
    
    Parameters:
    -----------
    x_coords : array-like
        X coordinates of original points
    y_coords : array-like  
        Y coordinates of original points
    values : array-like
        Values at each point
    multiplier : int, default=16
        How many times more points to generate (e.g., 8 means 8x more points)
    
    Returns:
    --------
    tuple: (new_x_coords, new_y_coords, new_values)
        Arrays of interpolated points
    """
    
    x_coords = np.array(x_coords)
    y_coords = np.array(y_coords)
    values = np.array(values)

    x_min, x_max = x_coords.min(), x_coords.max()
    y_min, y_max = y_coords.min(), y_coords.max()

    # Estimate original spacing in each dimension independently
    dx = np.median(np.diff(np.unique(np.sort(x_coords))))
    dy = np.median(np.diff(np.unique(np.sort(y_coords))))

    # New spacing is original divided by multiplier
    dx_new = dx / multiplier
    dy_new = dy / multiplier

    # Build grid with new spacing (multiplier times denser in each axis)
    x_grid = np.arange(x_min, x_max + dx_new, dx_new)
    y_grid = np.arange(y_min, y_max + dy_new, dy_new)
    X_grid, Y_grid = np.meshgrid(x_grid, y_grid)
    new_x = X_grid.flatten()
    new_y = Y_grid.flatten()

    # Interpolate
    original_points = np.column_stack([x_coords, y_coords])
    new_points = np.column_stack([new_x, new_y])
    new_values = griddata(original_points, values, new_points, method='cubic', fill_value=np.nan)

    # Remove NaNs
    mask = ~np.isnan(new_values)
    new_x, new_y, new_values = new_x[mask], new_y[mask], new_values[mask]

    # Remove points too far from any original point
    dists_threshold = max(dx, dy) * np.sqrt(2) / 2.0
    tree = KDTree(np.column_stack([x_coords, y_coords]))
    dists = tree.query(np.column_stack([new_x, new_y]), k=1)[0]
    keep = dists <= dists_threshold

    return new_x[keep], new_y[keep], new_values[keep]

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
    
    # Calculate bounds
    x_min, x_max = x_coords.min(), x_coords.max()
    y_min, y_max = y_coords.min(), y_coords.max()
    
    # Create target grid based on original point density
    n_original = len(x_coords)
    n_target = int(n_original * multiplier)
    
    # Estimate grid density (assuming roughly square distribution)
    grid_side = int(np.sqrt(n_target))
   
    # Create denser grid of points
    grid_side = int(np.sqrt(n_target))
    x_grid = np.linspace(x_min, x_max, grid_side)
    y_grid = np.linspace(y_min, y_max, grid_side)
    X_grid, Y_grid = np.meshgrid(x_grid, y_grid)
    new_x = X_grid.flatten()
    new_y = Y_grid.flatten()
    
    # Interpolate values using griddata
    original_points = np.column_stack([x_coords, y_coords])
    new_points = np.column_stack([new_x, new_y])
    
    # linear, cubic, or nearest
    new_values = griddata(original_points, values, new_points, method='cubic', fill_value=np.nan)
    
    # Remove NaN values
    mask = ~np.isnan(new_values)
    new_x = new_x[mask]
    new_y = new_y[mask]
    new_values = new_values[mask]

    tspx = int(np.round(np.median(np.diff(np.unique(np.sort(x_coords))))))
    dists_threshold = tspx * np.sqrt(2) / 2.
    tree = KDTree(np.vstack([x_coords, y_coords]).T)
    dists_mask = tree.query(np.vstack([new_x, new_y]).T, k=1)[0] <= dists_threshold
    new_x = new_x[dists_mask]
    new_y = new_y[dists_mask]
    new_values = new_values[dists_mask]
    
    return new_x, new_y, new_values

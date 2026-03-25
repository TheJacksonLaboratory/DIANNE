
"""Author: Sergii Domanskyi
Organization: The Jackson Laboratory for Genomic Medicine
Date: 2025-01-27

The getDiscreteCombinedCDF function computes the combined cumulative distribution function (CDF) from two CDFs.
It takes as input parameters the quantile and feature values along with weights for each of the two input CDFs.
The function uses a supplementary function getDiscretePDF that generates a discrete PDF interpolated into N points from each of the two coarse CDFs.
The resulting discrete PDF values are concatenated and sorted by the feature value. The cumulative sum of the y values is then computed and normalized,
followed by the filtering of CDF values to be within the range of the specified quantiles.
The filtered CDF values are re-scaled to precisely match the range of the input quantiles.

Function getDiscreteCombinedCDF is purely numpy based. The function getDiscreteCombinedCDFofAllFeatures is a wrapper around getDiscreteCombinedCDF that
computes the combined CDF for all features in the input arrays, leveraging the parallel processing capabilities of the numba library in nopython mode.

Description:
This script contains functions to compute the combined cumulative distribution function (CDF) from two discrete probability density functions (PDFs).
The main functions are:
- getDiscreteCombinedCDF: Computes the combined CDF from two input CDFs.
- getDiscreteCombinedCDFofAllFeatures: Computes the combined CDF for all features in the input arrays using parallel processing.

Dependencies:
- numpy
- numba
"""

import numpy as np
from numba import jit, prange

@jit(nopython=True)
def getDiscreteCombinedCDF(qs, v1, i1, v2, i2, alpha=1., beta=1., interpolate_n=200, debug=False):

    """Compute the combined cumulative distribution function (CDF) from two discrete probability density functions (PDFs).

    Parameters:
    qs (array-like):
        Quantiles at which to evaluate the combined CDF.
        E.g., np.array([0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95])

    v1 (array-like):
        Values for the first CDF.

    i1 (array-like):
        Feature values for the first CDF.
    
    v2 (array-like):
        Values for the second CDF.

    i2 (array-like):
        Feature values for the second CDF.
    
    alpha (float, optional):
        Weight for the first PDF. Default is 1.

    beta (float, optional):
        Weight for the second PDF. Default is 1.

    interpolate_n (int, optional):
        Number of points for interpolation. Default is 200.

    debug (bool, optional):
        If True, return additional debug information. Default is False.

    Returns:
        Interpolated values of the combined CDF at the specified quantiles.
    
    If debug is True, returns a tuple containing:
    - Interpolated values of the combined CDF at the specified quantiles.
    - Interpolated x-values for the first PDF.
    - Interpolated PDF values for the first PDF.
    - Interpolated x-values for the second PDF.
    - Interpolated PDF values for the second PDF.
    - Combined and sorted x-values.
    - Combined and sorted cumulative y-values.
    """

    def getDiscretePDF(x10in, y10in, interpolate_n=200):
    
        """Generate a discrete probability density function (PDF) from given data points.

        Parameters:
        x10in (array-like):
            The x-coordinates of the input data points.

        y10in (array-like):
            The y-coordinates of the input data points.

        interpolate_n (int, optional):
            The number of points to use for interpolation. Default is 200.

        Returns:
        tuple: A tuple containing:
            - xN (numpy.ndarray): The x-coordinates of the interpolated points.
            - dpdf (numpy.ndarray): The discrete PDF values corresponding to xN.
        """
    
        x10 = np.concatenate((np.array([x10in[0] - (x10in[1]-x10in[0])]), x10in))
        y10 = np.concatenate((np.array([0]), y10in))
        pdf = np.diff(y10) / np.diff(x10)
        pdf = np.concatenate((pdf, np.array([0])))
        x10 = np.concatenate((x10, np.array([x10[-1] + 0.5*(x10[-1]-x10[-2])])))
        pdf = np.concatenate((np.array([pdf[0]]), pdf))
        xN = np.linspace(x10.min(), x10.max(), interpolate_n)
        pdf = np.interp(xN, x10, pdf)
        dpdf = np.concatenate((np.array([0]), ((np.roll(pdf, -1) + pdf)/2)[1:] * np.diff(xN)))
        dpdf /= np.sum(dpdf)
    
        return xN, dpdf

    xN1, pdf1 = getDiscretePDF(v1, i1, interpolate_n=interpolate_n)
    xN2, pdf2 = getDiscretePDF(v2, i2, interpolate_n=interpolate_n)

    x = np.concatenate((xN1, xN2))
    order = np.argsort(x)
    x = x[order]
    y = np.concatenate((alpha * pdf1, beta * pdf2))
    y = np.cumsum(y[order])
    y /= y.max()
    y = y - y.min()

    # Should be turned of for use with njit
    if False:
        if debug:
            return np.interp(qs, y, x), xN1, pdf1, xN2, pdf2, x, y

    return np.interp(qs, y, x)

@jit(nopython=True, parallel=True)
def getDiscreteCombinedCDFofAllFeatures(qs, a1, a2, alpha=1., beta=1.):

    """Compute the combined cumulative distribution function (CDF) of all features.
    This function calculates the combined CDF for each feature in the input arrays `a1` and `a2`
    using the provided quantiles `qs`. The combined CDF is computed using the `getDiscreteCombinedCDF`
    function for each feature.

    Parameters:
    qs : array-like
        The quantiles at which CDFs a1 and a2 were computed of shape (number of quantiles,).

    a1 : array-like
        The first set of features. Must have the same shape as `a2`, (number of quantiles, number of features).

    a2 : array-like
        The second set of features. Must have the same shape as `a1`, (number of quantiles, number of features).

    alpha : float, optional
        The alpha parameter for the combined CDF calculation. Default is 1.

    beta : float, optional
        The beta parameter for the combined CDF calculation. Default is 1.

    Returns:
    cdf : array-like
        The combined CDF of all features, with the same shape as `a1` and `a2`.
    """
    
    assert a1.shape == a2.shape
    cdf = np.empty_like(a1, dtype=a1.dtype)

    for i in prange(a1.shape[1]):
        cdf[:, i] = getDiscreteCombinedCDF(qs, a1[:, i], qs, a2[:, i], qs, alpha=alpha, beta=beta)

    return cdf

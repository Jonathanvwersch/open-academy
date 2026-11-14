"""Common mistake: treating the origin as the data mean."""
from pathlib import Path
import runpy

globals().update({
    key: value for key, value in runpy.run_path(str(Path(__file__).with_name("pca.py"))).items()
    if not key.startswith("__")
})


def centre(X):
    return X.copy(), np.zeros(X.shape[1])

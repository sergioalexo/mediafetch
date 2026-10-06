//! Small filesystem helpers shared by the modules that persist state.

use std::path::{Path, PathBuf};

/// Write via a temporary file and rename, so an interrupted write leaves the
/// previous file intact instead of a half-written one that parses as empty.
///
/// std::fs::rename replaces the destination on every platform we ship
/// (MoveFileEx with MOVEFILE_REPLACE_EXISTING on Windows), so the old file
/// stays readable right up to the swap. On failure the previous file is still
/// on disk untouched — only the temp file needs clearing.
pub fn write_atomic(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let mut tmp_name = path.as_os_str().to_owned();
    tmp_name.push(".tmp");
    let tmp = PathBuf::from(tmp_name);
    let result = std::fs::write(&tmp, contents).and_then(|()| std::fs::rename(&tmp, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

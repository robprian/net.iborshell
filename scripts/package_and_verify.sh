#!/usr/bin/env bash
# Package the plugin, then run the acceptance smokes against the binary
# packed INSIDE the .dbxp (SKILL.md "双冒烟验收" semantics, scripted).
#
# Closes the replacement window O5: `dbx-plugin package` rebuilds and
# overwrites backend/target/release/<binary>, so smokes run against the
# target dir may not exercise the bytes that were actually shipped. Here the
# binary is extracted from the package and used via DBX_PLUGIN_SIDECAR.
#
# Usage:
#   scripts/package_and_verify.sh              # build + package + verify
#   scripts/package_and_verify.sh --no-build   # reuse the existing dist/*.dbxp
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
export PATH="$HOME/.cargo/bin:$PATH"
# 与 test.sh 同款一次性数据目录：standalone 运行若读真实用户插件设置，压缩
# 偏好等会让 smoke 期望误判（compression='none' vs gzip），且测试会写脏用户配置。
export DBX_PLUGIN_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dbx-pkg-verify-data.XXXXXX")"

if [ "${1:-}" != "--no-build" ]; then
  echo "==> cargo build --release"
  cargo build --release --manifest-path backend/Cargo.toml
  echo "==> dbx-plugin package ."
  # 与 build.sh 同款垫片：unset 会让 npm 包装器回注 CLI 自带 sdk-root（旧
  # vendored SDK），仓库 shared/sdk 的本地修复进不了包（0.4.79 案例）。
  export DBX_PLUGIN_SDK_ROOT="$(bash scripts/sdk_root_shim.sh)"
  NO_COLOR=1 dbx-plugin package .
fi

PKG="$ROOT/$(ls -t dist/*.dbxp | head -1)"
echo "==> verifying package: $PKG"

VERIFY_DIR="$(mktemp -d /tmp/dbx-pkg-verify.XXXXXX)"
trap 'rm -rf "$VERIFY_DIR"' EXIT
unzip -q "$PKG" -d "$VERIFY_DIR"
BINARY="$(find "$VERIFY_DIR/bin" -type f -name net-iborshell -perm -111 -print -quit)"
[ -n "$BINARY" ] || { echo "FAIL: packaged net-iborshell binary missing under $VERIFY_DIR/bin"; exit 1; }
echo "packaged binary sha256: $(shasum -a 256 "$BINARY" | awk '{print $1}')"

export DBX_PLUGIN_SIDECAR="$BINARY"
echo "==> smoke_test.py (against packaged binary)"
python3 scripts/smoke_test.py
echo "==> smoke_fs_test.py (against packaged binary)"
python3 scripts/smoke_fs_test.py
echo "==> smoke_batch3_test.py (against packaged binary)"
python3 scripts/smoke_batch3_test.py
echo "package verification green"

#!/bin/sh
# Installs the T3 Code CLI from a GitHub Release archive. Needs only sh, tar,
# sha256sum or shasum, and curl or wget; no Node, npm, or compiler.
#
#   curl -fsSL https://raw.githubusercontent.com/mikkelon/t3code/main/scripts/install.sh | sh
#
# On Linux, --desktop also installs the desktop app (AppImage, app menu
# launcher and icon), and --uninstall-desktop removes it again:
#
#   curl -fsSL https://raw.githubusercontent.com/mikkelon/t3code/main/scripts/install.sh | sh -s -- --desktop
#   curl -fsSL https://raw.githubusercontent.com/mikkelon/t3code/main/scripts/install.sh | sh -s -- --uninstall-desktop
#
# Environment:
#   T3CODE_CHANNEL           release train to follow: stable, nightly, or preview
#                            (default: stable; preview is a maintainers' test train)
#   T3CODE_VERSION           exact version to install (overrides T3CODE_CHANNEL)
#   T3CODE_HOME              T3 home directory (default: ~/.t3)
#   T3CODE_INSTALL_BIN_DIR   where the `t3` symlink goes (default: ~/.local/bin)
#   T3CODE_RELEASE_BASE_URL  mirror for releases/download (default: GitHub)
#   T3CODE_RELEASE_INDEX_URL release list used to pick a version (default: GitHub API)
#   T3CODE_DESKTOP_DIR       where --desktop puts T3-Code.AppImage
#                            (default: $XDG_DATA_HOME/t3code)
#   T3CODE_NO_LAUNCH         set to 1 so --desktop does not start the app
#   XDG_DATA_HOME            base for the app, launcher and icon
#                            (default: ~/.local/share)
#
# The archive is unpacked into $T3CODE_HOME/runtime/versions/<version>, the
# same layout `t3 service install` uses, so the service reuses this download
# instead of fetching the release again.
set -eu

repo="mikkelon/t3code"
base_url="${T3CODE_RELEASE_BASE_URL:-https://github.com/${repo}/releases/download}"
t3_home="${T3CODE_HOME:-$HOME/.t3}"
bin_dir="${T3CODE_INSTALL_BIN_DIR:-$HOME/.local/bin}"

fail() {
  printf '\nt3 install: %s\n' "$1" >&2
  exit 1
}

# ANSI stays on stderr, so `curl ... | sh` still gets progress.
interactive=false
if [ -t 2 ] && [ "${TERM:-}" != dumb ]; then interactive=true; fi
reset= bold= muted= accent= green=
if "$interactive" && [ -z "${NO_COLOR:-}" ]; then
  reset="$(printf '\033[0m')"; bold="$(printf '\033[1m')"
  muted="$(printf '\033[2m')"; accent="$(printf '\033[94m')"; green="$(printf '\033[32m')"
fi
step() {
  if "$interactive"; then printf '\r\033[2K  %s%s%s' "$muted" "$1" "$reset" >&2
  else printf '  %s\n' "$1" >&2; fi
}
# --desktop installs the CLI as usual, then the Linux desktop app.
# --uninstall-desktop removes only the desktop app, without any download.
mode=cli
for arg in "$@"; do
  case "$arg" in
    --desktop | --uninstall-desktop) ;;
    *) fail "unknown argument '${arg}'; the options are --desktop and --uninstall-desktop" ;;
  esac
  [ "$mode" = cli ] || [ "$mode" = "${arg#--}" ] || fail "use either --desktop or --uninstall-desktop, not both"
  mode="${arg#--}"
done
banner_label=CLI
if [ "$mode" != cli ]; then
  [ "$(uname -s)" = Linux ] || fail "--${mode} is only for Linux; there is no desktop app build of this fork for $(uname -s)"
  data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
  data_home="${data_home%/}"
  desktop_dir="${T3CODE_DESKTOP_DIR:-$data_home/t3code}"
  desktop_dir="${desktop_dir%/}"
  case "$data_home" in /*) ;; *) fail "XDG_DATA_HOME must be an absolute path" ;; esac
  case "$desktop_dir" in /*) ;; *) fail "T3CODE_DESKTOP_DIR must be an absolute path" ;; esac
  # A fixed, version-less name: electron-updater's AppImageUpdater replaces
  # this file in place, so the launcher keeps working across app updates.
  appimage="${desktop_dir}/T3-Code.AppImage"
  apps_dir="${data_home}/applications"
  launcher="${apps_dir}/com.t3tools.T3Code.desktop"
  icon="${data_home}/icons/com.t3tools.T3Code.desktop.png"
fi
refresh_desktop_database() {
  if command -v update-desktop-database >/dev/null 2>&1 && [ -d "$apps_dir" ]; then
    update-desktop-database "$apps_dir" >/dev/null 2>&1 || true
  fi
}
if [ "$mode" = uninstall-desktop ]; then
  removed=false
  for file in "$appimage" "$launcher" "$icon"; do
    if [ -e "$file" ] || [ -L "$file" ]; then
      rm -f "$file"
      printf '  Removed %s\n' "$file"
      removed=true
    fi
  done
  [ -n "${T3CODE_DESKTOP_DIR:-}" ] || rmdir "$desktop_dir" 2>/dev/null || true
  refresh_desktop_database
  "$removed" || printf '  The T3 Code desktop app is not installed.\n'
  printf '\n  %s\n  %s\n\n' \
    "The t3 CLI, the background service and ~/.t3 were left in place." \
    "Run t3 uninstall to remove the CLI and the service; it keeps ~/.t3/userdata."
  exit 0
fi
if [ "$mode" = desktop ]; then
  banner_label=Desktop
  nl='
'
  case "${appimage}${icon}" in *"$nl"*) fail "the desktop app paths cannot contain a newline" ;; esac
  # Reads stdin so a backslash in the path cannot change sha512sum's output.
  if command -v sha512sum >/dev/null 2>&1; then
    sha512_hex() { sha512sum < "$1" | cut -d' ' -f1; }
  elif command -v shasum >/dev/null 2>&1; then
    sha512_hex() { shasum -a 512 < "$1" | cut -d' ' -f1; }
  else
    fail "sha512sum or shasum is required for --desktop"
  fi
  if command -v base64 >/dev/null 2>&1; then
    base64_decode() { base64 -d; }
  elif command -v openssl >/dev/null 2>&1; then
    base64_decode() { openssl base64 -d -A; }
  else
    fail "base64 or openssl is required for --desktop"
  fi
  command -v od >/dev/null 2>&1 || fail "od is required for --desktop"
  command -v awk >/dev/null 2>&1 || fail "awk is required for --desktop"
fi

if "$interactive"; then
  printf '\n%s' "$bold" >&2
  printf '  %s\n' '██████████ ████████ ' >&2
  printf '  %s\n' '    ███       ▄██▀       T3 Code' >&2
  printf '  %s%s     %s%s installer%s\n' '    ███       ████▄ ' "$reset" "$muted" "$banner_label" "$reset$bold" >&2
  printf '  %s\n' '    ███    ▄     ███' >&2
  printf '  %s\n' '    ███    ███████▀ ' >&2
  printf '%s\n' "$reset" >&2
fi
step "Finding your release..."

# Exit 44 on a 404 so callers can tell "no such asset" from a network failure.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    status="$(curl -sSL -w '%{http_code}' "$1" -o "$2")" || return 1
    case "$status" in
      2??) return 0 ;;
      404) return 44 ;;
      *) printf 'GET %s returned HTTP %s\n' "$1" "$status" >&2; return 1 ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    wget -q --server-response "$1" -O "$2" 2>"$2.headers" && rm -f "$2.headers" && return 0
    if grep -q ' 404 ' "$2.headers" 2>/dev/null; then rm -f "$2.headers"; return 44; fi
    cat "$2.headers" >&2; rm -f "$2.headers"; return 1
  else
    fail "curl or wget is required"
  fi
}

mb() {
  tenths=$((($1 * 10 + 524288) / 1048576))
  printf '%s.%s' "$((tenths / 10))" "$((tenths % 10))"
}
# Poll the file written by the downloader; no progress-output parsing or extra request.
download() {
  if ! "$interactive"; then fetch "$1" "$2"; return; fi
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -D "$2.headers" "$1" -o "$2" 2>"$2.errors" &
  else
    wget -q --server-response "$1" -O "$2" 2>"$2.headers" &
  fi
  download_pid=$!
  previous=-1
  cr="$(printf '\r')"
  while kill -0 "$download_pid" 2>/dev/null; do
    bytes=0; total=0
    if [ -f "$2" ]; then bytes="$(wc -c < "$2")"; fi
    if [ -f "$2.headers" ]; then
      while read -r key value; do
        case "$key" in
          HTTP/*) total=0 ;;
          [Cc]ontent-[Ll]ength:) total="${value%"$cr"}" ;;
        esac
      done < "$2.headers"
    fi
    case "$total" in ''|*[!0-9]*) total=0 ;; esac
    if [ "$bytes" -ne "$previous" ]; then
      if [ "$total" -gt 0 ]; then
        percent=$((bytes * 100 / total)); [ "$percent" -le 100 ] || percent=100
        filled=$((percent * 32 / 100)); bar=; rest=; n=0
        while [ "$n" -lt 32 ]; do
          if [ "$n" -lt "$filled" ]; then bar="${bar}■"; else rest="${rest}·"; fi
          n=$((n + 1))
        done
        printf '\r\033[2K  %s%s%s%s%s %3d%%  %s%s / %s MB%s' "$accent" "$bar" "$reset$muted" "$rest" "$reset" "$percent" "$muted" "$(mb "$bytes")" "$(mb "$total")" "$reset" >&2
      else
        printf '\r\033[2K  %sDownloading%s  %s MB' "$muted" "$reset" "$(mb "$bytes")" >&2
      fi
      previous="$bytes"
    fi
    sleep 0.1
  done
  result=0; wait "$download_pid" || result=$?
  download_pid=
  if [ "$result" -ne 0 ]; then
    printf '\n' >&2
    if [ -f "$2.errors" ]; then cat "$2.errors" >&2; else cat "$2.headers" >&2; fi
    return "$result"
  fi
  size="$(mb "$(wc -c < "$2")")"
  printf '\r\033[2K  %s■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■%s 100%%  %s%s / %s MB%s\n' "$accent" "$reset" "$muted" "$size" "$size" "$reset" >&2
  rm -f "$2.headers" "$2.errors"
}

case "$(uname -s)" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) fail "unsupported operating system $(uname -s); use the desktop app or npm" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac
command -v tar >/dev/null 2>&1 || fail "tar is required"
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is required"
fi

channel="${T3CODE_CHANNEL:-stable}"
version="${T3CODE_VERSION:-}"
if [ -z "$version" ]; then
  # Tags are v<semver>; the channel is the prerelease identifier, or none for
  # stable. This fork's releases are stable with a `-mk.<n>` suffix. Only tags
  # of the requested train are considered, so a stable install can never pick
  # up a nightly or preview build by accident.
  case "$channel" in
    stable) tag_pattern='v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\(-mk\.[0-9][0-9]*\)\{0,1\}\)' ;;
    nightly | preview) tag_pattern="v\([0-9][^\"]*-${channel}\.[0-9]*\.[0-9]*\)" ;;
    *) fail "T3CODE_CHANNEL must be stable, nightly, or preview" ;;
  esac
  tmp_index="$(mktemp)"
  fetch "${T3CODE_RELEASE_INDEX_URL:-https://api.github.com/repos/${repo}/releases?per_page=100}" "$tmp_index"
  version="$(sed -n "s/.*\"tag_name\": *\"${tag_pattern}\".*/\1/p" "$tmp_index" | head -n 1)"
  rm -f "$tmp_index"
  [ -n "$version" ] || fail "could not find a ${channel} release; set T3CODE_VERSION"
fi
case "$version" in
  *-preview.*)
    printf '%s\n' \
      "t3 ${version} is a preview build." \
      "  Preview builds are cut by maintainers from unreleased branches to exercise the release" \
      "  pipeline. They can be broken, receive no fixes, and are never offered as updates." \
      "  Set T3CODE_CHANNEL=stable (the default) for a supported build." >&2
    if [ "$channel" != "preview" ] && [ -z "${T3CODE_VERSION:-}" ]; then
      fail "refusing a preview build that was not explicitly requested"
    fi
    ;;
esac

stem="t3-${version}-${platform}-${arch}"
archive="${stem}.tar.gz"
versions_dir="${t3_home}/runtime/versions"
target_dir="${versions_dir}/${version}"

if [ -f "${target_dir}/.install-complete" ] && [ "$(cat "${target_dir}/.install-complete")" = "$version" ]; then
  step "Version ${version} is already downloaded."
else
  mkdir -p "$versions_dir"
  staging="$(mktemp -d "${versions_dir}/.staging-XXXXXX")"
  download_pid=
  trap '[ -z "$download_pid" ] || { kill "$download_pid" 2>/dev/null || true; wait "$download_pid" 2>/dev/null || true; }; rm -rf "$staging"' EXIT
  trap 'printf "\n" >&2; exit 130' INT
  trap 'printf "\n" >&2; exit 143' TERM

  if "$interactive"; then printf '\r\033[2K' >&2; fi
  printf '  %sInstalling%s T3 Code %s%s%s\n\n' "$muted" "$reset" "$bold" "$version" "$reset" >&2
  step "Downloading..."
  fetch_status=0
  fetch "${base_url}/v${version}/SHA256SUMS" "${staging}/SHA256SUMS" || fetch_status=$?
  if [ "$fetch_status" -eq 44 ]; then
    fail "t3 ${version} has no release archive for ${platform}-${arch}"
  elif [ "$fetch_status" -ne 0 ]; then
    fail "could not download the release checksums"
  fi
  download "${base_url}/v${version}/${archive}" "${staging}/${archive}"

  step "Verifying the download..."
  expected="$(grep " \*\{0,1\}${archive}\$" "${staging}/SHA256SUMS" | cut -d' ' -f1)"
  [ -n "$expected" ] || fail "${archive} is not listed in SHA256SUMS"
  actual="$(checksum "${staging}/${archive}")"
  [ "$actual" = "$expected" ] || fail "checksum mismatch for ${archive}"

  step "Extracting T3 Code..."
  tar -xzf "${staging}/${archive}" -C "$staging" --strip-components=1
  rm -f "${staging}/${archive}" "${staging}/SHA256SUMS"
  "${staging}/t3" --version >/dev/null || fail "the downloaded executable does not run"
  printf '%s\n' "$version" > "${staging}/.install-complete"

  rm -rf "$target_dir"
  mv "$staging" "$target_dir"
  trap - EXIT
fi

step "Setting up the t3 command..."
mkdir -p "$bin_dir"
ln -sfn "${target_dir}/t3" "${bin_dir}/t3"
if "$interactive"; then printf '\r\033[2K' >&2; fi
printf '  %sInstalled T3 Code %s%s\n\n' "$green" "$version" "$reset" >&2
case ":${PATH}:" in
  *":${bin_dir}:"*) printf '  Run %st3%s to get started.\n\n' "$bold" "$reset" ;;
  *) printf '  Add %s to your PATH, then run %st3%s.\n\n' "$bin_dir" "$bold" "$reset" ;;
esac

[ "$mode" = desktop ] || exit 0

say() {
  if "$interactive"; then printf '\r\033[2K' >&2; fi
  printf '  %s\n' "$1" >&2
}

# The sha512 (base64) of the `files:` entry whose url is $2 in an
# electron-builder update feed ($1).
feed_sha512() {
  awk -v name="$2" '
    { sub(/\r$/, "") }
    /^[^ ]/ { url = "" }
    $1 == "-" && $2 == "url:" { url = $3 }
    $1 == "sha512:" && url == name { print $2; exit }
  ' "$1"
}

# The launcher must stay byte-identical to what renderUrlHandlerDesktopEntry
# in apps/desktop/src/app/DesktopLinuxUrlHandler.ts renders with
# launcherWmClass set (the canonical field list); otherwise the app rewrites
# it on every launch. These two mirror its string and Exec escaping.
tab="$(printf '\t')"
cr="$(printf '\r')"
desktop_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/${tab}/\\\\t/g" -e "s/${cr}/\\\\r/g"
}
desktop_exec_arg() {
  # shellcheck disable=SC2016 # sed expressions, not shell expansions
  quoted="$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/`/\\`/g' -e 's/\$/\\$/g' -e 's/"/\\"/g' -e 's/%/%%/g')"
  desktop_escape "\"${quoted}\""
}

# The AppImage runtime dlopen()s libfuse.so.2 to mount itself.
has_fuse2() {
  for ldconfig in "$(command -v ldconfig 2>/dev/null || true)" /sbin/ldconfig /usr/sbin/ldconfig; do
    if [ -x "$ldconfig" ] && "$ldconfig" -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then return 0; fi
  done
  for lib in /usr/lib/libfuse.so.2 /usr/lib64/libfuse.so.2 /usr/lib/*/libfuse.so.2 \
    /lib/libfuse.so.2 /lib64/libfuse.so.2 /lib/*/libfuse.so.2; do
    if [ -e "$lib" ]; then return 0; fi
  done
  return 1
}

desktop_cleanup() {
  if [ -n "${download_pid:-}" ]; then
    kill "$download_pid" 2>/dev/null || true
    wait "$download_pid" 2>/dev/null || true
  fi
  if [ -n "$desktop_tmp" ]; then
    rm -f "$desktop_tmp" "${desktop_tmp}.yml" "${desktop_tmp}.yml.headers" "${desktop_tmp}.headers" "${desktop_tmp}.errors"
  fi
  [ -z "$icon_work" ] || rm -rf "$icon_work"
  [ -z "$icon_tmp" ] || rm -f "$icon_tmp"
  [ -z "$launcher_tmp" ] || rm -f "$launcher_tmp"
}

case "$arch" in
  x64) appimage_arch=x86_64; feed=latest-linux.yml ;;
  arm64) appimage_arch=arm64; feed=latest-linux-arm64.yml ;;
esac
appimage_name="T3-Code-${version}-${appimage_arch}.AppImage"
no_build="no Linux desktop build for ${appimage_arch} in ${version}"
# Mirrors resolveDesktopAppBranding in apps/desktop/src/app/DesktopEnvironment.ts.
case "$version" in
  *-nightly.* | *-preview.*) display_name="T3 Code (Nightly)" ;;
  *) display_name="T3 Code (Alpha)" ;;
esac

download_pid='' desktop_tmp='' icon_work='' icon_tmp='' launcher_tmp=''
trap desktop_cleanup EXIT
trap 'printf "\n" >&2; exit 130' INT
trap 'printf "\n" >&2; exit 143' TERM
mkdir -p "$desktop_dir"
# Next to the target, so the final mv is an atomic rename. A running app keeps
# its mounted old file, as it does when electron-updater replaces it.
desktop_tmp="$(mktemp "${desktop_dir}/.T3-Code.AppImage.XXXXXX")"

step "Checking the desktop app..."
fetch_status=0
fetch "${base_url}/v${version}/${feed}" "${desktop_tmp}.yml" || fetch_status=$?
[ "$fetch_status" -ne 44 ] || fail "$no_build"
[ "$fetch_status" -eq 0 ] || fail "could not download ${feed}"
expected="$(feed_sha512 "${desktop_tmp}.yml" "$appimage_name")"
[ -n "$expected" ] || fail "$no_build"
expected="$(printf '%s' "$expected" | base64_decode | od -An -tx1 | tr -d ' \n')"
[ "${#expected}" -eq 128 ] || fail "${feed} has an unreadable checksum for ${appimage_name}"

if [ -f "$appimage" ] && [ "$(sha512_hex "$appimage")" = "$expected" ]; then
  say "The T3 Code ${version} desktop app is already installed."
else
  say "${muted}Installing${reset} the T3 Code desktop app ${bold}${version}${reset}"
  step "Downloading..."
  download_status=0
  download "${base_url}/v${version}/${appimage_name}" "$desktop_tmp" || download_status=$?
  [ "$download_status" -ne 44 ] || fail "$no_build"
  [ "$download_status" -eq 0 ] || fail "could not download ${appimage_name}"
  step "Verifying the download..."
  [ "$(sha512_hex "$desktop_tmp")" = "$expected" ] || fail "checksum mismatch for ${appimage_name}"
  chmod 755 "$desktop_tmp"
  mv -f "$desktop_tmp" "$appimage"
fi
rm -f "$desktop_tmp" "${desktop_tmp}.yml"
desktop_tmp=

# Extraction needs no FUSE. In the release .DirIcon links to the packaged
# icon under usr/share/icons, which is extracted first so cp -L can follow it.
step "Installing the icon..."
icon_work="$(mktemp -d)"
if ! {
  (cd "$icon_work" && "$appimage" --appimage-extract 'usr/share/icons/*' &&
    "$appimage" --appimage-extract .DirIcon) >/dev/null &&
    mkdir -p "${icon%/*}" &&
    icon_tmp="$(mktemp "${icon%/*}/.com.t3tools.T3Code.desktop.png.XXXXXX")" &&
    cp -L "${icon_work}/squashfs-root/.DirIcon" "$icon_tmp" &&
    chmod 644 "$icon_tmp" &&
    mv -f "$icon_tmp" "$icon"
} 2>/dev/null; then
  [ -z "$icon_tmp" ] || rm -f "$icon_tmp"
  say "Could not extract the icon; the app installs its icon on first launch."
fi
rm -rf "$icon_work"
icon_work='' icon_tmp=''

step "Adding T3 Code to the app menu..."
mkdir -p "$apps_dir"
launcher_tmp="$(mktemp "${apps_dir}/.com.t3tools.T3Code.desktop.XXXXXX")"
printf '%s\n' \
  '[Desktop Entry]' \
  'Type=Application' \
  "Name=${display_name}" \
  "Exec=$(desktop_exec_arg "$appimage") %U" \
  "Icon=$(desktop_escape "$icon")" \
  'Terminal=false' \
  'StartupNotify=false' \
  'StartupWMClass=t3code' \
  'Categories=Development;' \
  'MimeType=x-scheme-handler/t3code;' > "$launcher_tmp"
chmod 644 "$launcher_tmp"
mv -f "$launcher_tmp" "$launcher"
launcher_tmp=
refresh_desktop_database
trap - EXIT

say "${green}Installed the T3 Code desktop app ${version}${reset}"
printf '\n  App       %s\n  Launcher  %s\n\n  T3 Code is in your app menu.\n' "$appimage" "$launcher"
if ! has_fuse2; then
  printf '%s\n' "" \
    "  AppImages need FUSE 2 (libfuse.so.2), which is missing here. Install it, then start" \
    "  T3 Code from your app menu: fuse2 (Arch), libfuse2t64 (Ubuntu 24.04+, Debian 13)," \
    "  libfuse2 (older Debian and Ubuntu) or fuse-libs (Fedora)."
elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && [ "${T3CODE_NO_LAUNCH:-}" != 1 ]; then
  nohup "$appimage" < /dev/null > /dev/null 2>&1 &
  printf '\n  Starting T3 Code...\n'
else
  printf '\n  Start it from your app menu, or run %s\n' "$appimage"
fi
printf '\n'

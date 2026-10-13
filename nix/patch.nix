# Adds one line to the Claude desktop app's entry file so it loads Normal Mode
# at startup. If the file it points at is missing, the app starts as usual.
{ pkgs, claude-desktop, src, loadFrom ? null }:

let
  # this flake's copy in the Nix store, or a live checkout under $HOME
  main =
    if loadFrom == null
    then ''"${src}/main.js"''
    else ''require("os").homedir()+"/${loadFrom}/main.js"'';
in
claude-desktop.overrideAttrs (old: {
  nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [ pkgs.asar ];
  postInstall = (old.postInstall or "") + ''
    root="$(mktemp -d)"
    asar extract "$out/lib/claude-desktop/resources/app.asar" "$root"
    echo ';try{require(${main})}catch(e){console.error("[normal-mode]",e)}' >> "$root/.vite/build/index.js"
    rm "$out/lib/claude-desktop/resources/app.asar"
    asar pack --unpack "*.node" "$root" "$out/lib/claude-desktop/resources/app.asar"
  '';
})

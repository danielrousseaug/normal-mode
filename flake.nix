{
  description = "Normal Mode: vim-style keys for the Claude desktop app (unofficial)";

  outputs = { self }: {
    # Returns your Claude desktop package, patched to load Normal Mode:
    #   normal-mode.lib.patch pkgs claude-desktop { }
    # loadFrom (a folder under $HOME) loads a live checkout instead of the
    # copy in this flake, so edits apply with gR:
    #   normal-mode.lib.patch pkgs claude-desktop { loadFrom = "code/normal-mode/src"; }
    lib.patch = pkgs: claude-desktop: { loadFrom ? null }:
      import ./nix/patch.nix {
        inherit pkgs claude-desktop loadFrom;
        src = ./src;
      };
  };
}

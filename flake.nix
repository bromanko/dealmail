{
  description = "DealMail development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        dealmail = pkgs.callPackage ./nix/dealmail.nix { };
      in
      {
        packages = {
          dealmail = dealmail;
          default = dealmail;
        };

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_latest
            nodePackages.typescript
            nodePackages.ts-node
            pnpm_9
          ];
        };
      }
    );
}

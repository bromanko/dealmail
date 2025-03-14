{
  stdenv,
  nodejs,
  pnpm,
  lib,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "dealmail";
  version = "0.1.0";

  src = ../.;

  nativeBuildInputs = [
    nodejs
    pnpm.configHook
  ];

  pnpmDeps = pnpm.fetchDeps {
    inherit (finalAttrs) pname version src;
    hash = lib.fakeHash;
  };

  postBuild = ''
    pnpm run build
  '';
})

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
    hash = "sha256-PkziW+SDNrMuH6gZjim49ax2IXLLeHRyXmIutoRrO7c=";
  };

  postBuild = ''
    pnpm run build
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/{bin,lib/node_modules/dealmail}
    
    # Copy the built app and dependencies to lib/node_modules
    cp -r package.json pnpm-lock.yaml dist node_modules $out/lib/node_modules/dealmail/
    
    # Create executable wrapper script
    cat > $out/bin/dealmail << EOF
    #!/usr/bin/env bash
    NODE_PATH=$out/lib/node_modules/dealmail/node_modules exec ${nodejs}/bin/node $out/lib/node_modules/dealmail/dist/index.js "\$@"
    EOF
    
    chmod +x $out/bin/dealmail

    runHook postInstall
  '';
})

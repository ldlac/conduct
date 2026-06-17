{ pkgs, lib, config, inputs, ... }:

{
  packages = [
    pkgs.pnpm_10
    pkgs.nodejs_22
  ];

  dotenv.disableHint = true;

  enterShell = ''
  '';

  enterTest = ''
  '';
}
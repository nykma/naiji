{
  description = "奶记 · 婴儿喂养记录 (Node.js + SQLite: server / web / cli)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forEachSystem = f: nixpkgs.lib.genAttrs systems (system: f { inherit system; pkgs = nixpkgs.legacyPackages.${system}; });
    in
    {
      devShells = forEachSystem (
        { pkgs, ... }:
        {
          default = pkgs.mkShellNoCC {
            packages = [
              (pkgs.nodejs_24 or pkgs.nodejs)
              pkgs.curl
            ];
            shellHook = ''
              # 让 naiji 命令指向工作区里的 CLI（跟随源码改动，不冻结到 nix store）
              export PATH="$PWD/cli/bin:$PATH"
              echo "奶记 dev shell: $(node --version) · server: npm start · cli: naiji · 测试: npm test"
            '';
          };
        }
      );
    };
}

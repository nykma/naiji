{
  description = "奶记 · 婴儿喂养记录 (Node.js + SQLite)";

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
              echo "奶记 dev shell: $(node --version) (npm start 启动, npm test 测试)"
            '';
          };
        }
      );
    };
}

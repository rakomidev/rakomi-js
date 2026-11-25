// SPDX-License-Identifier: MIT

/** A quickstart template slug accepted by the scaffolder. */
export type TemplateSlug = "nextjs" | "react" | "node" | "expo";

/** A scaffoldable quickstart template, baked in from the shared manifest at build time. */
export interface Template {
  readonly slug: TemplateSlug;
  readonly label: string;
  /** Public source repository as "owner/name". */
  readonly publicRepo: string;
  /** The commit of `publicRepo` this release fetches (40 hex), pinned at release time. */
  readonly commit: string;
  /** sha512 (hex) of the codeload tarball of `commit`; the archive is refused on mismatch. */
  readonly archiveSha512: string;
}

/** The full set of templates, in manifest order. */
export const TEMPLATES: readonly Template[] = [
  { slug: "nextjs", label: "Next.js quickstart", publicRepo: "rakomidev/rakomi-nextjs-quickstart", commit: "7c68886517218950058bffc53d9716d3d7279576", archiveSha512: "0b516632fdfa83e2c12b73577c4c2c61aa6099ba430c9865964b59c1ea3b259e414520b169f539bc2fc7036f2560e9cca77884aae65b79e0fce6a7519a98bfb3" },
  { slug: "react", label: "React quickstart", publicRepo: "rakomidev/rakomi-react-quickstart", commit: "66240aa34ba1916277318c8b73903432fe1a610d", archiveSha512: "7663c40198e95a4530bfe19ae7a2aeaf599a61a09cd390d6ab48c35dbc300577b4eb42c712dc686c583c9d35ea63cd9dcabbe4e8733671c89c69c91b76432d8b" },
  { slug: "node", label: "Node quickstart", publicRepo: "rakomidev/rakomi-node-quickstart", commit: "946526e8717850150f4de1d041c0155a5f654a4c", archiveSha512: "eae521cfd30fa9139fa5f66e4ccb57ffc4f74506ec8d11ae44c495cba19fd96b4dc78948deb687f9559348b0673e6cb5b66169d335f0aae39f9c784c1cd5f43d" },
  { slug: "expo", label: "Expo quickstart", publicRepo: "rakomidev/rakomi-expo-quickstart", commit: "8f1a253ce19071773d20f0038823f6cff129c7de", archiveSha512: "b754c805f5fdf49a18aeb5c44f1735b850138a0f059b43a6db5d06f90c2d094f68f406784fe3a558cae519b10b2e2286cb4a82cc223a264ca3cb2b2779fbbb85" },
];

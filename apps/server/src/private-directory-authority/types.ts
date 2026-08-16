declare const privateDirectoryAuthorityBrand: unique symbol;

/** Proof that the named paths passed the platform's private-directory policy. */
export interface PrivateDirectoryAuthority {
  readonly root: string;
  readonly marker: string;
  readonly controlled_directories: readonly string[];
  readonly [privateDirectoryAuthorityBrand]: true;
}

export interface PrivateDirectoryControlledEntry {
  readonly name: string;
  readonly kind: "file" | "directory";
  readonly size: number;
  readonly identity: Readonly<{
    readonly device: string;
    readonly file: string;
  }>;
}

export interface PrivateDirectoryControlledFileReader {
  read(offset: number, max_bytes: number): Promise<Uint8Array | null>;
}

export interface PublishControlledFileRequest {
  readonly controlled_leaf: string;
  readonly final_name: string;
  readonly expected_sha256: string;
  readonly expected_bytes: number;
  readonly reader: PrivateDirectoryControlledFileReader;
}

export interface PublishControlledFileResult {
  readonly outcome: "published" | "existing_identical" | "existing_different";
  readonly sha256: string;
  readonly bytes: number;
}

export type LibraryAccessMode = "all" | "selected";

export interface MediaLibrarySummary {
  id: string;
  mediaKind: "audio" | "mixed" | "video";
  name: string;
}

export interface MemberLibraryAccess {
  disabled: boolean;
  displayName: string;
  id: string;
  libraryIds: string[];
  mode: LibraryAccessMode;
  username: string;
}

export interface LibraryPermissionsAdministration {
  libraries: MediaLibrarySummary[];
  members: MemberLibraryAccess[];
}

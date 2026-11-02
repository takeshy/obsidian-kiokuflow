// Google Drive API client for Obsidian.
// The REST client (requests, retries, pagination, multipart bodies, errors) is
// shared with kiokuflow web and Desktop through gemihub-sync-core; this module
// only adapts Obsidian's requestUrl as the transport.

import { requestUrl } from "obsidian";
import {
  createDriveClient,
  headersFromRecord,
  type DriveFile,
  type DriveHttpRequest,
  type DriveHttpResponse,
} from "gemihub-sync-core/drive";

export { DriveApiError, isDriveNotFoundError, type DriveFile } from "gemihub-sync-core/drive";

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/** requestUrl as a DriveTransport (Content-Type goes through its contentType field). */
async function requestUrlTransport(request: DriveHttpRequest): Promise<DriveHttpResponse> {
  const headers = { ...request.headers };
  const contentType = headers["Content-Type"];
  delete headers["Content-Type"];
  const response = await requestUrl({
    url: request.url,
    method: request.method,
    headers,
    contentType,
    body: request.body instanceof Uint8Array ? toArrayBuffer(request.body) : request.body,
    throw: false,
  });
  return {
    status: response.status,
    headers: headersFromRecord(response.headers),
    text: () => Promise.resolve(response.text),
    json: () => Promise.resolve(response.json as unknown),
    arrayBuffer: () => Promise.resolve(response.arrayBuffer),
  };
}

const drive = createDriveClient(requestUrlTransport);

// ========================================
// Folder operations
// ========================================

export function ensureRootFolder(accessToken: string, folderName: string = "kiokuflow"): Promise<string> {
  return drive.ensureRootFolder(accessToken, folderName);
}

export function ensureSubFolder(accessToken: string, parentId: string, folderName: string): Promise<string> {
  return drive.ensureSubFolder(accessToken, parentId, folderName);
}

/**
 * Ensure nested folder path exists on Drive, returning the deepest folder's ID.
 * e.g., "notes/daily" creates "notes" then "daily" inside it.
 */
export function ensureFolderPath(accessToken: string, rootFolderId: string, folderPath: string): Promise<string> {
  return drive.ensureFolderPath(accessToken, rootFolderId, folderPath);
}

export function listFolders(accessToken: string, parentId: string): Promise<DriveFile[]> {
  return drive.listFolders(accessToken, parentId);
}

// ========================================
// File listing and lookup
// ========================================

export function listFiles(accessToken: string, folderId: string, mimeType?: string): Promise<DriveFile[]> {
  return drive.listFiles(accessToken, folderId, mimeType);
}

/** Syncable root files (no folders, system files or Workspace-native files). */
export function listUserFiles(accessToken: string, rootFolderId: string): Promise<DriveFile[]> {
  return drive.listUserFiles(accessToken, rootFolderId);
}

export function findFileByExactName(accessToken: string, name: string, parentId?: string): Promise<DriveFile | null> {
  return drive.findFileByExactName(accessToken, name, parentId);
}

/** Every non-folder file with this exact name (duplicates included). */
export function findFilesByExactName(accessToken: string, name: string, parentId?: string): Promise<DriveFile[]> {
  return drive.findFilesByExactName(accessToken, name, parentId);
}

export function getFileMetadata(accessToken: string, fileId: string): Promise<DriveFile> {
  return drive.getFileMetadata(accessToken, fileId);
}

// ========================================
// File read / write
// ========================================

export function readFile(accessToken: string, fileId: string): Promise<string> {
  return drive.readFile(accessToken, fileId);
}

export async function readFileRaw(accessToken: string, fileId: string): Promise<ArrayBuffer> {
  return toArrayBuffer(await drive.readFileBytes(accessToken, fileId));
}

export function createFile(
  accessToken: string,
  name: string,
  content: string,
  parentId: string,
  mimeType: string = "text/plain"
): Promise<DriveFile> {
  return drive.createFile(accessToken, name, content, parentId, mimeType);
}

export function createFileBinary(
  accessToken: string,
  name: string,
  contentBuffer: ArrayBuffer,
  parentId: string,
  mimeType: string = "application/octet-stream"
): Promise<DriveFile> {
  return drive.createFileBinary(accessToken, name, contentBuffer, parentId, mimeType);
}

export function updateFile(
  accessToken: string,
  fileId: string,
  content: string,
  mimeType: string = "text/plain"
): Promise<DriveFile> {
  return drive.updateFile(accessToken, fileId, content, mimeType);
}

export function updateFileBinary(
  accessToken: string,
  fileId: string,
  contentBuffer: ArrayBuffer,
  mimeType: string = "application/octet-stream"
): Promise<DriveFile> {
  return drive.updateFileBinary(accessToken, fileId, contentBuffer, mimeType);
}

// ========================================
// Move / rename / delete
// ========================================

export async function moveFile(
  accessToken: string,
  fileId: string,
  newParentId: string,
  oldParentId: string
): Promise<void> {
  await drive.moveFile(accessToken, fileId, newParentId, oldParentId);
}

export function renameFile(accessToken: string, fileId: string, newName: string): Promise<DriveFile> {
  return drive.renameFile(accessToken, fileId, newName);
}

/** Permanent delete — use for temp/system files only. */
export function deleteFile(accessToken: string, fileId: string): Promise<void> {
  return drive.deleteFile(accessToken, fileId);
}

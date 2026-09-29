/**
 * @file fal video input upload — the first frame first and alone, then the
 * image, audio and video refs and the end frame (last) in parallel over the
 * shared `../client/upload.ts` session, so a failed first-frame upload sends
 * every later file of the request as a data URI.
 */

import type { VideoFile } from "../../video/contract";
import type { UploadOptions } from "../client/upload";
import { createUploadSession, uploadFiles, uploadOne } from "../client/upload";
import type { FalContext } from "../types";
import type { SplitReferences, UploadedUrls } from "./models";

/**
 * Makes a request's first frame, refs and end frame readable by fal: the
 * first frame first, then the image, audio and video refs and the end frame
 * (last) in parallel, at most 4 at a time. After an upload failure the
 * remaining files of this call go as data URIs.
 *
 * @param ctx - Plugin context (`config.upload`, `config.uploadUrl`, `config.timeoutMs`, `state.uploads`, `log`).
 * @param image - The first frame.
 * @param references - Image, audio and video refs, already checked against the model's limits.
 * @param options - Key and caller signal.
 * @param endImage - The end frame, when the request has one (the model was checked to take it).
 * @returns URLs (or data URIs) for the image, for each image, audio and video ref in order, and for the end frame when there is one.
 * @throws {Error} When a file cannot be read, or the caller aborted.
 */
export async function uploadInputs(
  ctx: FalContext,
  image: VideoFile,
  references: SplitReferences,
  options: UploadOptions,
  endImage?: VideoFile
): Promise<UploadedUrls> {
  // The first frame goes first, alone; a failure here flips the session to data-uri
  const session = createUploadSession(ctx);
  const imageUrl = await uploadOne(ctx, session, image, options);

  // Every ref, then the end frame, in parallel, UPLOAD_SLOTS at a time, in request order
  const files = [...references.images, ...references.audio, ...references.videos];
  if (endImage !== undefined) files.push(endImage);
  const urls = await uploadFiles(ctx, files, options, session);

  // Slice the flat URL list back into the three groups and the end frame
  const audioStart = references.images.length;
  const videoStart = audioStart + references.audio.length;
  const endStart = videoStart + references.videos.length;
  const base: UploadedUrls = {
    image: imageUrl,
    refs: urls.slice(0, audioStart),
    audioRefs: urls.slice(audioStart, videoStart),
    videoRefs: urls.slice(videoStart, endStart)
  };
  const endUrl = urls[endStart];
  return endUrl === undefined ? base : { ...base, endImage: endUrl };
}

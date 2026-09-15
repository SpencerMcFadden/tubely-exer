import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, UserForbiddenError } from "./errors";
import path from "node:path";
import { randomBytes } from "node:crypto";

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const video = getVideo(cfg.db, videoId);
  if (video?.userID !== userID) {
    throw new UserForbiddenError("Must own the video");
  }

  const MAX_UPLOAD_SIZE = 10 << 20;
  const formData = await req.formData();
  const thumbnail = formData.get("thumbnail");
  if (!(thumbnail instanceof File)) {
    throw new BadRequestError("Thumbnail is not type File");
  }
  if (thumbnail.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Thumbnail is too large");
  }

  const mediaType = thumbnail.type;
  if (mediaType !== `image/jpeg` && mediaType !== `image/png`) {
    throw new BadRequestError("Image must be a jpeg or png");
  }
  const imageData = await thumbnail.arrayBuffer();
  const imageFileName = `${randomBytes(32).toString("base64")}.${mediaType}`;
  const imagePath = path.join(cfg.assetsRoot, imageFileName);

  Bun.write(imagePath, imageData);
  video.thumbnailURL = `http://localhost:${cfg.port}/assets/${imageFileName}`;
  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}

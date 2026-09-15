import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const MAX_UPLOAD_SIZE = 1 << 30; //1GB
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading video", videoId, "by user", userID);

  const video = getVideo(cfg.db, videoId);
  if (video?.userID !== userID) {
    throw new UserForbiddenError("You do not own this video");
  }

  const formData = await req.formData();
  const videoData = formData.get("video");
  if (!(videoData instanceof File)) {
    throw new BadRequestError("Video is not type File");
  }
  if (videoData.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Video is too large. Max upload size is 1GB");
  }

  const mediaType = videoData.type;
  if (mediaType !== "video/mp4") {
    throw new BadRequestError("Video must be an mp4");
  }

  const tempPath = `${videoId}.mp4`;
  await Bun.write(tempPath, videoData);

  const file = cfg.s3Client.file(tempPath);
  file.write(Bun.file(tempPath), {
    type: mediaType,
  });

  video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${videoId}.mp4`;
  updateVideo(cfg.db, video);

  await Bun.file(tempPath).delete();
  return respondWithJSON(200, null);
}

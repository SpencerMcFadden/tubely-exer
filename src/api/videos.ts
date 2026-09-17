import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo, type Video } from "../db/videos";

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

  const tempProcessedPath = await processVideoForFastStart(tempPath);

  const aspectRatio = await getVideoAspectRatio(tempProcessedPath);

  const key = `${aspectRatio}/${tempProcessedPath}`;
  const file = cfg.s3Client.file(key);
  file.write(Bun.file(tempProcessedPath), {
    type: mediaType,
  });

  video.videoURL = `${cfg.s3CfDistribution}/${key}`;
  updateVideo(cfg.db, video);

  await Bun.file(tempPath).delete();
  await Bun.file(tempProcessedPath).delete();
  return respondWithJSON(200, null);
}

export async function processVideoForFastStart(inputFilePath: string) {
  const outputFilePath = inputFilePath + ".processed";
  const proc = Bun.spawn([
    "ffmpeg",
    "-i",
    inputFilePath,
    "-movflags",
    "faststart",
    "-map_metadata",
    "0",
    "-codec",
    "copy",
    "-f",
    "mp4",
    outputFilePath,
  ]);
  if ((await proc.exited) !== 0) {
    throw new BadRequestError(`ffmpeg error`);
  }
  return outputFilePath;
}

async function getVideoAspectRatio(filePath: string) {
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filePath,
    ],
    {
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) {
    throw new BadRequestError(`ffprobe error: ${stderrText}`);
  }

  const output = JSON.parse(stdoutText);
  if (!output.streams || output.streams.length === 0) {
    throw new Error("No video streams found");
  }

  const { width, height } = output.streams[0];

  return width === Math.floor(16 * (height / 9))
    ? "landscape"
    : height === Math.floor(16 * (width / 9))
      ? "portrait"
      : "other";
}

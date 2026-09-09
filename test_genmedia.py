"""Generates one image and one video without the Live session.

Usage:
    python test_genmedia.py                 image and video with a default prompt
    python test_genmedia.py image           image only
    python test_genmedia.py video A cat surfing at sunset
"""
import asyncio
import sys
import time

from dotenv import load_dotenv

load_dotenv()

from live_avatar_agent import genmedia

DEFAULT_PROMPT = "A red bicycle leaning against a sunlit brick wall, photorealistic"


async def main():
    args = sys.argv[1:]
    what = args.pop(0) if args and args[0] in ("image", "video", "both") else "both"
    prompt = " ".join(args) or DEFAULT_PROMPT

    if what in ("image", "both"):
        print(f"Image with {genmedia.image_model()}: {prompt}")
        start = time.time()
        image = await genmedia.generate_image(prompt, "16:9")
        with open("test_image.png", "wb") as f:
            f.write(image.data)
        print(f"  saved test_image.png ({image.mime_type}, {len(image.data)} bytes, {time.time() - start:.1f}s)")

    if what in ("video", "both"):
        print(f"Video with {genmedia.video_model()}: {prompt}")
        start = time.time()
        video = await genmedia.generate_video(prompt, "16:9")
        with open("test_video.mp4", "wb") as f:
            f.write(video.data)
        print(f"  saved test_video.mp4 ({video.mime_type}, {len(video.data)} bytes, {time.time() - start:.1f}s)")


if __name__ == "__main__":
    asyncio.run(main())

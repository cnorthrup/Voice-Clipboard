#!/usr/bin/env python3
"""
YouTube video summarizer using Claude.

Usage:
    python summarize.py <youtube_url>
    python summarize.py <youtube_url> --model claude-opus-4-8

Requirements:
    pip install youtube-transcript-api anthropic
"""

import sys
import re
import argparse

def get_video_id(url: str) -> str | None:
    m = re.search(r'(?:v=|youtu\.be/|embed/|shorts/)([a-zA-Z0-9_-]{11})', url)
    return m.group(1) if m else None

def fetch_transcript(video_id: str) -> str:
    from youtube_transcript_api import YouTubeTranscriptApi, NoTranscriptFound, TranscriptsDisabled

    api = YouTubeTranscriptApi()
    try:
        transcript = api.fetch(video_id)
        return " ".join(t.text for t in transcript)
    except NoTranscriptFound:
        # Try any available language
        transcript_list = api.list(video_id)
        for t in transcript_list:
            fetched = t.fetch()
            return " ".join(item.text for item in fetched)
    except TranscriptsDisabled:
        raise RuntimeError("Transcripts are disabled for this video.")

def summarize(transcript: str, url: str, model: str) -> str:
    import anthropic
    client = anthropic.Anthropic()

    message = client.messages.create(
        model=model,
        max_tokens=1024,
        messages=[
            {
                "role": "user",
                "content": (
                    f"Please summarize the following YouTube video transcript.\n"
                    f"Video URL: {url}\n\n"
                    f"Transcript:\n{transcript}\n\n"
                    f"Provide:\n"
                    f"1. A 2-3 sentence TL;DR\n"
                    f"2. Key points (bullet list)\n"
                    f"3. Any notable quotes or insights"
                ),
            }
        ],
    )
    return message.content[0].text

def main():
    parser = argparse.ArgumentParser(description="Summarize a YouTube video using Claude")
    parser.add_argument("url", help="YouTube video URL")
    parser.add_argument("--model", default="claude-opus-4-8", help="Claude model to use")
    parser.add_argument("--transcript-only", action="store_true", help="Print transcript without summarizing")
    args = parser.parse_args()

    video_id = get_video_id(args.url)
    if not video_id:
        print(f"Error: Could not extract video ID from URL: {args.url}", file=sys.stderr)
        sys.exit(1)

    print(f"Fetching transcript for video {video_id}...", file=sys.stderr)
    try:
        transcript = fetch_transcript(video_id)
    except Exception as e:
        print(f"Error fetching transcript: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"Transcript length: {len(transcript)} chars ({len(transcript.split())} words)", file=sys.stderr)

    if args.transcript_only:
        print(transcript)
        return

    print("Summarizing with Claude...\n", file=sys.stderr)
    try:
        summary = summarize(transcript, args.url, args.model)
        print(summary)
    except Exception as e:
        print(f"Error summarizing: {e}", file=sys.stderr)
        print("\nFalling back to raw transcript:\n")
        print(transcript[:3000])

if __name__ == "__main__":
    main()

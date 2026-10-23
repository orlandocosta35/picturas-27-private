"""Content inspection shared by video operations."""
from fractions import Fraction
import json
import math
import subprocess
from .common import VideoError, VideoInfo, finite_number

def probe_json(path, args, timeout=60):
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", *args, "-of", "json", str(path)],
            check=True, capture_output=True, text=True, timeout=max(0.01, timeout),
        )
        return json.loads(result.stdout)
    except FileNotFoundError:
        raise VideoError("FFPROBE_UNAVAILABLE", "FFprobe não está disponível.", 503) from None
    except subprocess.TimeoutExpired:
        raise VideoError("PROBE_TIMEOUT", "A análise do vídeo excedeu o tempo permitido.", 422) from None
    except (subprocess.CalledProcessError, ValueError):
        raise VideoError("UNREADABLE_VIDEO", "Não foi possível ler este vídeo.", 422) from None


def probe_video(path, timeout=60):
    """Inspect actual content; an upload's MIME type/extension is not evidence."""
    data = probe_json(path, ["-show_format", "-show_streams"], timeout)
    streams = data.get("streams", [])
    videos = [s for s in streams if s.get("codec_type") == "video"
              and not s.get("disposition", {}).get("attached_pic")]
    fmt = data.get("format", {})
    if not videos:
        raise VideoError("UNREADABLE_VIDEO", "Não foi possível ler este vídeo.", 422)
    video = videos[0]
    formats = set(fmt.get("format_name", "").split(","))
    if "mp4" in formats or "mov" in formats:
        container = "mov" if fmt.get("tags", {}).get("major_brand", "").strip() == "qt" else "mp4"
    elif "webm" in formats and video.get("codec_name") in {"vp8", "vp9", "av1"}:
        # ffprobe reports both matroska and webm; the EBML DocType disambiguates.
        container = "webm"
        with open(path, "rb") as source:
            if b"webm" not in source.read(4096):
                raise VideoError("UNSUPPORTED_FORMAT", "O formato deste vídeo não é suportado.", 415)
    else:
        raise VideoError("UNSUPPORTED_FORMAT", "O formato deste vídeo não é suportado.", 415)
    try:
        duration = finite_number(video.get("duration", fmt.get("duration")), "A duração")
        fps = Fraction(video.get("avg_frame_rate", "0/1"))
        if fps <= 0:
            fps = Fraction(video.get("r_frame_rate", "0/1"))
        width, height = int(video["width"]), int(video["height"])
        start_time = float(video.get("start_time", fmt.get("start_time", 0)))
        if duration <= 0 or fps <= 0 or width <= 0 or height <= 0 or not math.isfinite(start_time):
            raise ValueError
    except (KeyError, ValueError, ZeroDivisionError, VideoError):
        raise VideoError("UNREADABLE_VIDEO", "Não foi possível ler este vídeo.", 422) from None
    return VideoInfo(duration, width, height, fps, container,
                     any(s.get("codec_type") == "audio" for s in streams), start_time)

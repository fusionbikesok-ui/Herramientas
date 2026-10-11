"""Convert explicit browser recordings to bounded mono Ogg/Opus voice notes."""
from __future__ import annotations
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading

from .inbox_media import MAX_MEDIA, MediaError, validate_media

MAX_SECONDS = 300
_CONVERSIONS = threading.BoundedSemaphore(2)


def _run(tool, args, timeout):
    executable = shutil.which(tool)
    if not executable:
        raise MediaError('recording_converter_unavailable')
    command = [executable, *args]
    if os.name == 'posix':
        # Set rlimits in a fresh interpreter, never preexec_fn in the API's threads.
        limiter = "import os,resource,sys;resource.setrlimit(resource.RLIMIT_AS,(536870912,536870912));resource.setrlimit(resource.RLIMIT_CPU,(30,30));resource.setrlimit(resource.RLIMIT_FSIZE,(16777216,16777216));resource.setrlimit(resource.RLIMIT_NOFILE,(64,64));os.execv(sys.argv[1],sys.argv[1:])"
        command = [sys.executable, '-c', limiter, *command]
    try:
        process = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 timeout=timeout, check=False)
    except subprocess.TimeoutExpired as exc:
        raise MediaError('recording_conversion_timeout') from exc
    except OSError as exc:
        raise MediaError('recording_converter_unavailable') from exc
    if process.returncode or len(process.stdout) > 1024 * 1024:
        raise MediaError('recording_invalid_audio')
    return process.stdout


def _probe(path, demuxer):
    result = _run('ffprobe', ['-v', 'error', '-max_alloc', '33554432', '-protocol_whitelist', 'file', '-f', demuxer,
        '-show_entries', 'stream=codec_type,codec_name,channels,duration:format=duration', '-of', 'json', str(path)], 5)
    try:
        info = json.loads(result)
        streams = info['streams']
        if len(streams) != 1 or streams[0].get('codec_type') != 'audio':
            raise ValueError('streams')
        return info, streams[0]
    except (ValueError, KeyError, TypeError) as exc:
        raise MediaError('recording_invalid_audio') from exc


def convert_recording(content, mime):
    if not _CONVERSIONS.acquire(blocking=False):
        raise MediaError('recording_converter_busy')
    try:
        return _convert_recording(content,mime)
    finally:
        _CONVERSIONS.release()


def _convert_recording(content, mime):
    if not content or len(content) > MAX_MEDIA:
        raise MediaError('media_too_large' if content else 'empty_media')
    mime = str(mime).lower().split(';', 1)[0].strip()
    if mime == 'audio/webm' and content.startswith(b'\x1aE\xdf\xa3'):
        demuxer, codecs = 'matroska', {'opus'}
    elif mime == 'audio/ogg' and content.startswith(b'OggS'):
        demuxer, codecs = 'ogg', {'opus'}
    elif mime == 'audio/mp4' and len(content) >= 24 and content[4:8] == b'ftyp':
        demuxer, codecs = 'mov', {'aac', 'opus'}
    else:
        raise MediaError('recording_unsupported_format')
    with tempfile.TemporaryDirectory(prefix='fusion-voice-') as directory:
        source, output = Path(directory) / 'recording', Path(directory) / 'voice.ogg'
        source.write_bytes(content)
        info, stream = _probe(source, demuxer)
        if stream.get('codec_name') not in codecs:
            raise MediaError('recording_unsupported_codec')
        source_duration = (info.get('format') or {}).get('duration') or stream.get('duration')
        if source_duration not in (None, 'N/A'):
            try:
                if float(source_duration) > MAX_SECONDS + .1:
                    raise MediaError('recording_too_long')
            except (TypeError, ValueError) as exc:
                if isinstance(exc, MediaError):
                    raise
                raise MediaError('recording_invalid_audio') from exc
        args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-max_alloc', '33554432',
            '-protocol_whitelist', 'file', '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1', '-f', demuxer]
        if demuxer == 'mov':
            args += ['-enable_drefs', '0']
        args += ['-i', str(source), '-map', '0:a:0', '-vn', '-sn', '-dn', '-t', str(MAX_SECONDS + 1),
            '-map_metadata', '-1', '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', '-ar', '48000',
            '-threads', '1', '-fs', str(MAX_MEDIA), '-f', 'ogg', str(output)]
        _run('ffmpeg', args, 30)
        if not output.exists() or output.stat().st_size > MAX_MEDIA:
            raise MediaError('recording_invalid_audio')
        result = output.read_bytes()
        info, stream = _probe(output, 'ogg')
        try:
            duration = float((info.get('format') or {})['duration'])
        except (ValueError, TypeError, KeyError) as exc:
            raise MediaError('recording_invalid_audio') from exc
        if not 0 < duration <= MAX_SECONDS + .1:
            raise MediaError('recording_too_long' if duration > MAX_SECONDS else 'recording_invalid_audio')
        if stream.get('codec_name') != 'opus' or stream.get('channels') != 1:
            raise MediaError('recording_invalid_audio')
        validate_media(result, 'audio/ogg', 'audio.ogg')
        return result, round(duration, 2)

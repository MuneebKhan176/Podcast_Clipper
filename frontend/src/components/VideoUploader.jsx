import { useCallback, useEffect, useRef, useState } from 'react';
import { ChunkedUploader, UploadState } from '../upload/ChunkedUploader.js';
import { formatBytes } from '../utils/format.js';
import './VideoUploader.css';

const ALLOWED_EXTENSIONS = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'mpeg', 'mpg'];
const ACCEPT = ['video/*', ...ALLOWED_EXTENSIONS.map((e) => `.${e}`)].join(',');

function checkFile(file) {
  const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
  if (!ALLOWED_EXTENSIONS.includes(ext)) return `Please choose a video file (${ALLOWED_EXTENSIONS.join(', ')}).`;
  if (file.type && !file.type.startsWith('video/') && file.type !== 'application/octet-stream') {
    return 'That file does not look like a video.';
  }
  if (file.size === 0) return 'That file is empty.';
  return null;
}

const STATUS_TEXT = {
  [UploadState.PREPARING]: 'Preparing upload…',
  [UploadState.UPLOADING]: 'Uploading',
  [UploadState.PAUSED]: 'Paused',
  [UploadState.COMPLETING]: 'Finishing up — verifying your file…',
  [UploadState.COMPLETED]: 'Upload complete',
  [UploadState.ERROR]: 'Upload stopped',
  [UploadState.CANCELLED]: 'Upload cancelled',
};

/**
 * Pick a video, upload it in chunks straight to cloud storage, and resume if anything goes wrong.
 * `uploaderOptions` lets tests (or callers) inject the API / transport / timers.
 */
export default function VideoUploader({ onCompleted, uploaderOptions }) {
  const [file, setFile] = useState(null);
  const [snap, setSnap] = useState(null);
  const [pickError, setPickError] = useState('');
  const [dragging, setDragging] = useState(false);
  const uploaderRef = useRef(null);
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;

  const state = snap?.state;
  const busy = state === UploadState.PREPARING || state === UploadState.UPLOADING || state === UploadState.COMPLETING;

  const begin = useCallback((chosen) => {
    const uploader = new ChunkedUploader(chosen, {
      ...uploaderOptions,
      onChange: (s) => {
        if (uploaderRef.current === uploader) setSnap(s);
      },
    });
    uploaderRef.current = uploader;
    setFile(chosen);
    setSnap(uploader.snapshot());
    uploader.start().then((final) => {
      if (uploaderRef.current === uploader && final.state === UploadState.COMPLETED) {
        onCompletedRef.current?.(final.upload);
      }
    });
  }, [uploaderOptions]);

  function handleFiles(files) {
    const chosen = files?.[0];
    if (!chosen || busy) return;
    const problem = checkFile(chosen);
    setPickError(problem || '');
    if (!problem) begin(chosen);
  }

  // Closing the tab mid-upload is safe (it resumes), but warn so people don't do it by accident.
  useEffect(() => {
    if (!busy) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  // Stop network activity if the component goes away.
  useEffect(() => () => uploaderRef.current?.pause(), []);

  function reset() {
    uploaderRef.current = null;
    setFile(null);
    setSnap(null);
    setPickError('');
  }

  const resumedNote = snap?.resumedBytes > 0 && state !== UploadState.COMPLETED
    ? `Resuming: ${formatBytes(snap.resumedBytes)} were already uploaded and won't be sent again.`
    : '';

  return (
    <section className="uploader" aria-label="Upload a podcast video">
      {!file && (
        <label
          className={`uploader-drop${dragging ? ' dragging' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
        >
          <strong>Choose a video to upload</strong>
          <span>or drag and drop it here — large files (several GB) are fine</span>
          <input type="file" accept={ACCEPT} aria-label="Video file" onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }} />
        </label>
      )}

      {pickError && <div className="alert" role="alert">{pickError}</div>}

      {file && snap && (
        <>
          <div className="uploader-file">
            <strong>{file.name}</strong>
            <span className="uploader-meta">{formatBytes(snap.uploadedBytes)} of {formatBytes(snap.totalBytes)}</span>
          </div>

          <div
            className={`progress${state === UploadState.COMPLETED ? ' done' : ''}`}
            role="progressbar"
            aria-label="Upload progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={snap.percent}
          >
            <span style={{ width: `${snap.percent}%` }} />
          </div>

          <div className="uploader-status" role="status">
            {STATUS_TEXT[state]}
            {state === UploadState.UPLOADING && ` — ${snap.percent}%`}
            {state === UploadState.COMPLETED && snap.upload?.publicUrl && (
              <> — <a href={snap.upload.publicUrl} target="_blank" rel="noreferrer">open file</a></>
            )}
          </div>
          {resumedNote && <div className="uploader-notice">{resumedNote}</div>}
          {snap.notice && <div className="uploader-notice">{snap.notice}</div>}
          {state === UploadState.ERROR && <div className="alert" role="alert">{snap.error}</div>}

          <div className="uploader-actions">
            {state === UploadState.UPLOADING && (
              <button type="button" className="btn-secondary" onClick={() => uploaderRef.current.pause()}>Pause</button>
            )}
            {state === UploadState.PAUSED && (
              <button type="button" className="btn-primary" onClick={() => uploaderRef.current.start().then((f) => f.state === UploadState.COMPLETED && onCompletedRef.current?.(f.upload))}>Resume</button>
            )}
            {state === UploadState.ERROR && (
              <button type="button" className="btn-primary" onClick={() => uploaderRef.current.start().then((f) => f.state === UploadState.COMPLETED && onCompletedRef.current?.(f.upload))}>Resume upload</button>
            )}
            {(state === UploadState.UPLOADING || state === UploadState.PAUSED || state === UploadState.ERROR) && (
              <button type="button" className="btn-secondary" onClick={() => uploaderRef.current.cancel()}>Cancel</button>
            )}
            {(state === UploadState.COMPLETED || state === UploadState.CANCELLED) && (
              <button type="button" className="btn-secondary" onClick={reset}>Upload another video</button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

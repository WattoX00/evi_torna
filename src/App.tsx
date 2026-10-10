import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, ArrowDownAZ, ArrowUpDown, ArrowUpRight, Check, ChevronRight, Code2, Download, FileArchive,
  File as FileIcon, FileAudio2, FileImage, FileText, FileVideo2, Folder, FolderOpen, Github, Grid2X2,
  HardDrive, Info, LayoutGrid, List, LoaderCircle, LockKeyhole, MoreHorizontal, PanelTop, ScanLine,
  Plus, Printer, Search, Settings, Share2, ShieldCheck, Trash2, Upload, X,
} from 'lucide-react'

type SettingsForm = { username: string; owner: string; repo: string; branch: string; token: string }
type Config = Omit<SettingsForm, 'token'> & { token: string }
type Entry = { name: string; path: string; sha: string; size: number; type: 'file' | 'dir'; download_url?: string }
type Notice = { kind: 'error' | 'success'; text: string }

const emptyForm: SettingsForm = { username: '', owner: '', repo: '', branch: 'main', token: '' }
const API = 'https://api.github.com'
const MAX_CONTENT_SIZE = 100 * 1024 * 1024
const STORAGE_KEY = 'private-github-file-manager-connection'

function isConfig(value: unknown): value is Config {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return ['username', 'owner', 'repo', 'branch', 'token']
    .every(key => typeof candidate[key] === 'string' && candidate[key] !== '')
}

function readSavedConfig(): { config: Config | null; error?: string } {
  let saved: string | null
  try {
    saved = window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return { config: null, error: 'Could not access browser storage. Connection settings cannot be restored.' }
  }
  if (!saved) return { config: null }

  let parsed: unknown
  try {
    parsed = JSON.parse(saved)
  } catch {
    parsed = null
  }
  if (isConfig(parsed)) return { config: parsed }

  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    return { config: null, error: 'Saved connection settings are invalid and could not be cleared from browser storage.' }
  }
  return { config: null, error: 'Saved connection settings were invalid and have been cleared.' }
}

function apiError(message: string, status: number) {
  if (status === 401) return 'Token not accepted. Check that your fine-grained token is active.'
  if (status === 403) return 'GitHub denied access. Check repository permissions and API rate limits.'
  if (status === 404) return 'Repository, branch, or file not found. Check the settings and try again.'
  if (status === 409) return 'This file changed on GitHub. Refresh the folder and retry.'
  return message || `GitHub API request failed (${status}).`
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function fileIcon(name: string, size = 19) {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif'].includes(ext)) return <FileImage size={size} />
  if (['mp4', 'mov', 'webm'].includes(ext)) return <FileVideo2 size={size} />
  if (['mp3', 'wav', 'ogg'].includes(ext)) return <FileAudio2 size={size} />
  if (['zip', 'gz', 'tar', '7z'].includes(ext)) return <FileArchive size={size} />
  if (['md', 'txt', 'pdf', 'doc', 'docx', 'csv'].includes(ext)) return <FileText size={size} />
  if (['js', 'ts', 'tsx', 'jsx', 'json', 'html', 'css', 'py', 'go', 'rs'].includes(ext)) return <Code2 size={size} />
  return <FileIcon size={size} />
}

function App() {
  const [savedConfig] = useState(readSavedConfig)
  const [config, setConfig] = useState<Config | null>(savedConfig.config)
  const [form, setForm] = useState<SettingsForm>(savedConfig.config ?? emptyForm)
  const [connected, setConnected] = useState(Boolean(savedConfig.config))
  const [activeTab, setActiveTab] = useState<'files' | 'anatomy'>('files')
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<Entry[]>([])
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState<'name' | 'size'>('name')
  const [descending, setDescending] = useState(false)
  const [view, setView] = useState<'grid' | 'list'>('list')
  const [notice, setNotice] = useState<Notice | null>(savedConfig.error ? { kind: 'error', text: savedConfig.error } : null)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [preview, setPreview] = useState<{ entry: Entry; url: string; text?: string } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview.url)
  }, [preview])

  const request = async (url: string, options: RequestInit = {}, raw = false) => {
    if (!config) throw new Error('Connect a repository in Settings first.')
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        Authorization: `Bearer ${config.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.headers ?? {}),
      },
    })
    if (!response.ok) {
      let message = ''
      try {
        const body = await response.json() as { message?: string }
        message = body.message ?? ''
      } catch {
        message = response.statusText
      }
      throw new Error(apiError(message, response.status))
    }
    return response
  }

  const contentsUrl = (filePath = '') => {
    if (!config) throw new Error('Connect a repository in Settings first.')
    const encoded = filePath.split('/').map(encodeURIComponent).join('/')
    return `${API}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${encoded}?ref=${encodeURIComponent(config.branch)}`
  }

  const loadFolder = async (folder = path, activeConfig = config) => {
    if (!activeConfig) return
    setBusy(true)
    setNotice(null)
    try {
      const encoded = folder.split('/').filter(Boolean).map(encodeURIComponent).join('/')
      const response = await fetch(`${API}/repos/${encodeURIComponent(activeConfig.owner)}/${encodeURIComponent(activeConfig.repo)}/contents/${encoded}?ref=${encodeURIComponent(activeConfig.branch)}`, {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${activeConfig.token}`, 'X-GitHub-Api-Version': '2022-11-28' },
      })
      if (!response.ok) {
        let message = ''
        try { message = ((await response.json()) as { message?: string }).message ?? '' } catch { message = response.statusText }
        throw new Error(apiError(message, response.status))
      }
      const data = await response.json() as Array<{ name: string; path: string; sha: string; size: number; type: string; download_url?: string }>
      if (!Array.isArray(data)) throw new Error('Expected a folder listing, but GitHub returned a file.')
      setEntries(data.map(item => ({ name: item.name, path: item.path, sha: item.sha, size: item.size, type: item.type === 'dir' ? 'dir' : 'file', download_url: item.download_url })))
      setPath(folder)
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Could not load this folder.' })
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (config && connected) void loadFolder(path, config)
    // Reload when connection settings are successfully replaced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, connected])

  const visibleEntries = useMemo(() => entries
    .filter(item => item.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      const result = sortBy === 'size' && a.type === 'file' ? a.size - b.size : a.name.localeCompare(b.name)
      return descending ? -result : result
    }), [entries, query, sortBy, descending])

  const connect = async (event: React.FormEvent) => {
    event.preventDefault()
    const next: Config = { ...form, username: form.username.trim(), owner: form.owner.trim(), repo: form.repo.trim(), branch: form.branch.trim() }
    if (!next.username || !next.owner || !next.repo || !next.branch || !next.token) {
      setNotice({ kind: 'error', text: 'Complete every field before connecting.' })
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${next.token}`, 'X-GitHub-Api-Version': '2022-11-28' }
      const userResponse = await fetch(`${API}/user`, { headers })
      if (!userResponse.ok) throw new Error(apiError(userResponse.statusText, userResponse.status))
      const user = await userResponse.json() as { login: string }
      if (user.login.toLowerCase() !== next.username.toLowerCase()) {
        throw new Error(`The token belongs to @${user.login}, not @${next.username}.`)
      }
      const repoResponse = await fetch(`${API}/repos/${encodeURIComponent(next.owner)}/${encodeURIComponent(next.repo)}`, { headers })
      if (!repoResponse.ok) throw new Error(apiError(repoResponse.statusText, repoResponse.status))
      const repoData = await repoResponse.json() as { private: boolean; default_branch: string }
      if (!repoData.private) throw new Error('This repository is public. Select a private repository to connect.')
      const branchResponse = await fetch(`${API}/repos/${encodeURIComponent(next.owner)}/${encodeURIComponent(next.repo)}/branches/${encodeURIComponent(next.branch)}`, { headers })
      if (!branchResponse.ok) throw new Error(apiError(branchResponse.statusText, branchResponse.status))
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      setConfig(next)
      setConnected(true)
      setPath('')
      setSettingsOpen(false)
      setNotice({ kind: 'success', text: `Connected to ${next.owner}/${next.repo}${repoData.private ? ' · Private repository' : ''}.` })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Could not validate GitHub access.' })
    } finally {
      setBusy(false)
    }
  }

  const disconnect = () => {
    let storageError: string | null = null
    try {
      window.localStorage.removeItem(STORAGE_KEY)
    } catch {
      storageError = ' Could not clear the saved token from browser storage; it may be restored after reload.'
    }
    setConfig(null)
    setForm(emptyForm)
    setConnected(false)
    setActiveTab('files')
    setEntries([])
    setPath('')
    setPreview(null)
    setSettingsOpen(false)
    setNotice(storageError
      ? { kind: 'error', text: `Disconnected from this page.${storageError}` }
      : { kind: 'success', text: 'Disconnected. Your saved token has been cleared from this browser.' })
  }

  const readBlob = async (entry: Entry) => {
    const response = await request(contentsUrl(entry.path), {}, true)
    return response.blob()
  }

  const downloadFile = async (entry: Entry) => {
    setNotice(null)
    try {
      const blob = await readBlob(entry)
      saveBlob(blob, entry.name)
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Download failed.' })
    }
  }

  const openPreview = async (entry: Entry) => {
    setPreviewLoading(true)
    setNotice(null)
    try {
      const blob = await readBlob(entry)
      const url = URL.createObjectURL(blob)
      const textPreview = blob.type.startsWith('text/') || /\.(md|json|csv|xml|ya?ml|js|ts|css|html)$/i.test(entry.name)
      const text = textPreview && entry.size <= 2 * 1024 * 1024 ? await blob.text() : undefined
      setPreview({ entry, url, text })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Preview failed.' })
    } finally {
      setPreviewLoading(false)
    }
  }

  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length || !config) return
    setUploading(true)
    setUploadProgress(`Preparing ${files.length} ${files.length === 1 ? 'file' : 'files'}…`)
    setNotice(null)
    let completed = 0
    try {
      const selectedFiles = Array.from(files)
      for (const [index, file] of selectedFiles.entries()) {
        setUploadProgress(`Uploading ${index + 1} of ${selectedFiles.length}: ${file.name}`)
        if (file.size > MAX_CONTENT_SIZE) throw new Error(`${file.name} is larger than the 100 MB GitHub Contents API limit.`)
        const target = [path, file.name].filter(Boolean).join('/')
        const existingResponse = await fetch(contentsUrl(target), {
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${config.token}`, 'X-GitHub-Api-Version': '2022-11-28' },
        })
        let existingSha: string | undefined
        if (existingResponse.ok) {
          const existing = await existingResponse.json() as { type?: string; sha?: string }
          if (existing.type !== 'file' || !existing.sha) throw new Error(`Cannot replace ${file.name}: a folder already uses that name.`)
          if (!window.confirm(`"${file.name}" already exists. Replace it on ${config.branch}?`)) continue
          existingSha = existing.sha
        } else if (existingResponse.status !== 404) {
          let message = ''
          try { message = ((await existingResponse.json()) as { message?: string }).message ?? '' } catch { message = existingResponse.statusText }
          throw new Error(apiError(message, existingResponse.status))
        }
        const bytes = new Uint8Array(await file.arrayBuffer())
        let binary = ''
        const chunkSize = 0x8000
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
        }
        const content = btoa(binary)
        await request(contentsUrl(target), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: `${existingSha ? 'Update' : 'Upload'} ${file.name}`, content, branch: config.branch, ...(existingSha ? { sha: existingSha } : {}) }),
        })
        completed += 1
      }
      await loadFolder(path)
      setNotice({ kind: 'success', text: completed ? `${completed} ${completed === 1 ? 'file' : 'files'} uploaded or updated successfully.` : 'No files were uploaded.' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? `${completed ? `${completed} file(s) uploaded. ` : ''}${error.message}` : 'Upload failed.' })
    } finally {
      setUploading(false)
      setUploadProgress('')
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const deleteFile = async (entry: Entry) => {
    if (!config || !window.confirm(`Permanently delete "${entry.name}" from ${config.owner}/${config.repo}? This creates a commit on ${config.branch}.`)) return
    setBusy(true)
    setNotice(null)
    try {
      await request(contentsUrl(entry.path), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `Delete ${entry.name}`, sha: entry.sha, branch: config.branch }),
      })
      setEntries(current => current.filter(item => item.path !== entry.path))
      setNotice({ kind: 'success', text: `${entry.name} was deleted.` })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Delete failed.' })
    } finally {
      setBusy(false)
    }
  }

  const shareFile = async (entry: Entry) => {
    try {
      const blob = await readBlob(entry)
      const file = new File([blob], entry.name, { type: blob.type || 'application/octet-stream' })
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: entry.name })
          return
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') return
        }
      }
      saveBlob(blob, entry.name)
      const subject = encodeURIComponent(`Sharing ${entry.name}`)
      const body = encodeURIComponent(`I downloaded "${entry.name}". Please attach the downloaded file to this email.`)
      window.location.href = `mailto:?subject=${subject}&body=${body}`
      setNotice({ kind: 'success', text: 'File downloaded. Attach it to the email draft to share it.' })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Sharing failed.' })
    }
  }

  const printFile = async (entry: Entry) => {
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1
    if (!isMobile) {
      const blobUrl = config ? `https://github.com/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/blob/${encodeURIComponent(config.branch)}/${entry.path.split('/').map(encodeURIComponent).join('/')}` : ''
      window.open(blobUrl, '_blank', 'noopener,noreferrer')
      setNotice({ kind: 'success', text: 'GitHub opened in a new tab. Viewing a private file requires GitHub authentication and repository access. Use Preview or Download here for authenticated access.' })
      return
    }
    const opened = window.open('', '_blank')
    if (opened) opened.opener = null
    try {
      const blob = await readBlob(entry)
      const url = URL.createObjectURL(blob)
      if (opened) {
        opened.location.href = url
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      } else {
        saveBlob(blob, entry.name)
        setNotice({ kind: 'success', text: 'Your browser blocked the new tab, so the authenticated file was downloaded instead.' })
      }
    } catch (error) {
      opened?.close()
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Could not open this file.' })
    }
  }

  const breadcrumbs = ['', ...path.split('/').filter(Boolean)]

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={event => event.preventDefault()}>
          <span className="brand-mark"><HardDrive size={20} /></span>
          <span>vault<span className="brand-dot">.</span><small>PRIVATE FILES</small></span>
        </a>
        <div className="side-label">WORKSPACE</div>
        <button className={`nav-item ${activeTab === 'files' ? 'active' : ''}`} onClick={() => { setActiveTab('files'); setPath(''); if (config) void loadFolder('', config) }}>
          <LayoutGrid size={18} /> File browser
        </button>
        {connected && <button className={`nav-item ${activeTab === 'anatomy' ? 'active' : ''}`} onClick={() => setActiveTab('anatomy')}>
          <Activity size={18} /> 3D Anatomy
        </button>}
        <button className="nav-item" onClick={() => setSettingsOpen(true)}><Settings size={18} /> Settings</button>
        <div className="sidebar-bottom">
          <div className="secure-card">
            <span className="secure-icon"><ShieldCheck size={17} /></span>
            <strong>Your files stay yours</strong>
            <p>Your connection is saved in this browser, not on a server.</p>
            <span className="security-status"><span /> ENCRYPTED CONNECTION</span>
          </div>
          <div className="profile">
            <span className="avatar">{config?.username?.slice(0, 1).toUpperCase() ?? <Github size={17} />}</span>
            <span className="profile-label"><strong>{config ? `@${config.username}` : 'Not connected'}</strong><small>{config ? `${config.owner}/${config.repo}` : 'Connect a repository'}</small></span>
            <button className="icon-button" aria-label="Open settings" onClick={() => setSettingsOpen(true)}><MoreHorizontal size={19} /></button>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="mobile-brand"><span className="brand-mark"><HardDrive size={18} /></span><b>vault<span className="brand-dot">.</span></b></div>
          <div className="top-context"><span className="context-dot" /> PRIVATE WORKSPACE <ChevronRight size={14} /> <span>{activeTab === 'anatomy' ? '3D Anatomy' : 'File browser'}</span></div>
          <div className="top-actions"><span className="online-pill"><span /> SECURE SESSION</span><button className="icon-button settings-shortcut" aria-label="Settings" onClick={() => setSettingsOpen(true)}><Settings size={19} /></button></div>
        </header>
        {connected && <nav className="mobile-nav" aria-label="Workspace tabs">
          <button className={activeTab === 'files' ? 'active' : ''} aria-pressed={activeTab === 'files'} onClick={() => { setActiveTab('files'); setPath(''); if (config) void loadFolder('', config) }}>
            <LayoutGrid size={16} /> File browser
          </button>
          <button className={activeTab === 'anatomy' ? 'active' : ''} aria-pressed={activeTab === 'anatomy'} onClick={() => setActiveTab('anatomy')}>
            <Activity size={16} /> 3D Anatomy
          </button>
        </nav>}

        <section className="content">
          {activeTab === 'files' && <div className="page-heading">
            <div><div className="eyebrow">YOUR PERSONAL CLOUD</div><h1>File browser<span className="heading-period">.</span></h1><p className="subtitle">A quieter place for your important files.</p></div>
            <div className="heading-actions">
              {config && <button className="button secondary" onClick={() => void loadFolder(path)} disabled={busy}><ArrowUpDown size={16} /> Refresh</button>}
              <button className="button primary" onClick={() => config ? fileInput.current?.click() : setSettingsOpen(true)} disabled={uploading}>
                {uploading ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />} {uploading ? uploadProgress || 'Uploading…' : 'Upload files'}
              </button>
              <input ref={fileInput} type="file" multiple hidden onChange={event => void uploadFiles(event.target.files)} />
            </div>
          </div>}

          {notice && <div className={`notice ${notice.kind}`} role="status"><span>{notice.kind === 'error' ? <Info size={17} /> : <Check size={17} />}{notice.text}</span><button aria-label="Dismiss notice" onClick={() => setNotice(null)}><X size={16} /></button></div>}

          {!connected ? (
            <section className="welcome-card">
              <div className="welcome-graphic"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="welcome-icon"><LockKeyhole size={26} /></div><div className="float-chip chip-one"><Github size={16} /></div><div className="float-chip chip-two"><ShieldCheck size={16} /></div></div>
              <div className="welcome-copy"><span className="eyebrow">PRIVATE BY DESIGN</span><h2>Your files, your repository.</h2><p>Connect a private GitHub repository to browse, preview, and manage files from any device. Your access token is saved in this browser so you stay connected after a reload.</p><button className="button primary" onClick={() => setSettingsOpen(true)}><Github size={17} /> Connect your repository <ChevronRight size={16} /></button><div className="welcome-points"><span><Check size={14} /> No server-side storage</span><span><Check size={14} /> Fine-grained token</span></div></div>
            </section>
          ) : activeTab === 'anatomy' ? (
            <section className="anatomy-page">
              <div className="anatomy-hero">
                <div className="anatomy-copy">
                  <span className="anatomy-kicker"><span /> THE HUMAN BODY, REIMAGINED</span>
                  <h1>Explore anatomy<br /><span>in a new dimension.</span></h1>
                  <p>Step inside an immersive 3D anatomy experience. Rotate, zoom, and discover the body from every angle.</p>
                  <a className="anatomy-launch" href="https://jintai3d.com/viewer/?model=z-anatomy" target="_blank" rel="noopener noreferrer">
                    <ScanLine size={18} /> Launch 3D Anatomy <ArrowUpRight size={17} />
                  </a>
                  <div className="anatomy-note"><span className="anatomy-note-line" /> Opens the interactive viewer in a new tab</div>
                </div>
                <div className="anatomy-art" aria-label="Stylized anatomical illustration">
                  <div className="anatomy-orbit anatomy-orbit-one" />
                  <div className="anatomy-orbit anatomy-orbit-two" />
                  <span className="anatomy-coordinate coordinate-top">FIG. 01 <i>—</i> HUMAN</span>
                  <span className="anatomy-coordinate coordinate-bottom">INTERACTIVE <i>·</i> 3D MODEL</span>
                  <svg className="anatomy-figure" viewBox="0 0 300 490" role="img" aria-hidden="true">
                    <defs>
                      <linearGradient id="bodyGlow" x1="0" x2="1" y1="0" y2="1">
                        <stop offset="0" stopColor="#f3d8c6" />
                        <stop offset="1" stopColor="#d99b80" />
                      </linearGradient>
                    </defs>
                    <path className="body-shape" d="M150 43c-22 0-37 18-37 42 0 19 8 34 18 42l-3 22c-16 6-40 12-53 25-12 12-18 37-22 69l-13 91c-2 13 4 24 13 25 10 1 16-8 18-19l18-83 5 89-8 99c-1 12 5 20 14 20s15-7 17-18l18-91 13 0 18 91c2 11 8 18 17 18s15-8 14-20l-8-99 5-89 18 83c2 11 8 20 18 19 9-1 15-12 13-25l-13-91c-4-32-10-57-22-69-13-13-37-19-53-25l-3-22c10-8 18-23 18-42 0-24-15-42-37-42Z" />
                    <path className="body-detail" d="M150 128v210m-27-178c-16 12-22 35-22 58 0 17 8 30 21 38m55-96c16 12 22 35 22 58 0 17-8 30-21 38m-55-13c13 10 36 10 54 0m-56 32c15 13 42 13 57 0m-56 34c14 11 41 11 55 0m-52 36c13 9 35 9 48 0m-40 43 15 0m19 0 15 0" />
                    <path className="body-accent" d="M150 129c-13 0-21 12-21 26 0 13 8 20 21 20s21-7 21-20c0-14-8-26-21-26Zm-1 59v80m-20-30c10 8 31 8 42 0m-42 26c11 8 30 8 41 0" />
                  </svg>
                  <span className="anatomy-callout callout-one"><span /> MUSCULOSKELETAL</span>
                  <span className="anatomy-callout callout-two"><span /> HUMAN FORM</span>
                </div>
              </div>
              <div className="anatomy-bottom">
                <div><span className="anatomy-bottom-icon"><ScanLine size={18} /></span><span><strong>Look closer</strong><small>Explore the body in 3D</small></span></div>
                <div><span className="anatomy-bottom-icon"><Activity size={18} /></span><span><strong>Learn by exploring</strong><small>Move through the human form</small></span></div>
                <span className="anatomy-credit">POWERED BY JINTAI 3D <ArrowUpRight size={13} /></span>
              </div>
            </section>
          ) : (
            <>
              <section className="repo-strip">
                <span className="repo-icon"><Github size={19} /></span>
                <div className="repo-detail"><strong>{config?.owner}/{config?.repo}</strong><span><span className="private-badge"><LockKeyhole size={11} /> PRIVATE</span><span className="branch-label">Branch: <b>{config?.branch}</b></span></span></div>
                <button className="repo-settings" onClick={() => setSettingsOpen(true)}><Settings size={15} /> Repository settings</button>
              </section>
              <section className="file-panel">
                <div className="file-toolbar">
                  <div className="breadcrumbs" aria-label="Breadcrumb">
                    {breadcrumbs.map((crumb, index) => <span key={`${crumb}-${index}`}><button className={index === breadcrumbs.length - 1 ? 'crumb current' : 'crumb'} onClick={() => void loadFolder(breadcrumbs.slice(1, index + 1).join('/'))}>{index === 0 ? <FolderOpen size={16} /> : crumb}</button>{index < breadcrumbs.length - 1 && <ChevronRight size={14} />}</span>)}
                  </div>
                  <div className="file-tools"><label className="search-box"><Search size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search files…" /><kbd>⌘ K</kbd></label><button className={`view-button ${view === 'list' ? 'selected' : ''}`} aria-label="List view" onClick={() => setView('list')}><List size={17} /></button><button className={`view-button ${view === 'grid' ? 'selected' : ''}`} aria-label="Grid view" onClick={() => setView('grid')}><Grid2X2 size={16} /></button></div>
                </div>
                <div className={`file-table ${view}`}>
                  <div className="table-head"><span><button className="sort-control" onClick={() => { setSortBy('name'); setDescending(sortBy === 'name' ? !descending : false) }}>NAME <ArrowDownAZ size={14} /></button></span><span><button className="sort-control size-sort" onClick={() => { setSortBy('size'); setDescending(sortBy === 'size' ? !descending : false) }}>SIZE <ArrowUpDown size={13} /></button></span><span>LAST COMMIT</span><span /></div>
                  {busy && entries.length === 0 ? <div className="loading-state"><LoaderCircle className="spin" size={21} /> Connecting to GitHub…</div> :
                    visibleEntries.length === 0 ? <div className="empty-state"><span className="empty-icon"><Folder size={22} /></span><strong>{query ? 'No matching files' : 'This folder is empty'}</strong><p>{query ? 'Try another search term.' : 'Upload a file to get started.'}</p>{!query && <button className="text-button" onClick={() => fileInput.current?.click()}><Plus size={15} /> Upload a file</button>}</div> :
                      visibleEntries.map(entry => <div className="file-row" key={entry.path}>
                        <button className="file-main" onClick={() => entry.type === 'dir' ? void loadFolder(entry.path) : void openPreview(entry)}>
                          <span className={`file-icon ${entry.type === 'dir' ? 'folder-color' : ''}`}>{entry.type === 'dir' ? <Folder size={19} fill="currentColor" /> : fileIcon(entry.name)}</span>
                          <span className="file-name">{entry.name}</span>{entry.type === 'dir' && <ChevronRight className="row-chevron" size={15} />}
                        </button>
                        <span className="file-size">{entry.type === 'dir' ? '—' : formatBytes(entry.size)}</span><span className="commit-label">—</span>
                        <div className="row-actions">
                          {entry.type === 'file' && <><button className="row-action" title="Preview" aria-label={`Preview ${entry.name}`} onClick={() => void openPreview(entry)}><PanelTop size={16} /></button><button className="row-action" title="Download" aria-label={`Download ${entry.name}`} onClick={() => void downloadFile(entry)}><Download size={16} /></button><button className="row-action" title="Share" aria-label={`Share ${entry.name}`} onClick={() => void shareFile(entry)}><Share2 size={16} /></button><button className="row-action" title="Print / open" aria-label={`Print or open ${entry.name}`} onClick={() => void printFile(entry)}><Printer size={16} /></button></>}
                          {entry.type === 'file' && <button className="row-action delete-action" title="Delete" aria-label={`Delete ${entry.name}`} onClick={() => void deleteFile(entry)}><Trash2 size={16} /></button>}
                        </div>
                      </div>)}
                  {busy && entries.length > 0 && <div className="inline-loading"><LoaderCircle className="spin" size={15} /> Updating…</div>}
                </div>
                <div className="panel-footer"><span><span className="footer-dot" /> {visibleEntries.length} {visibleEntries.length === 1 ? 'item' : 'items'}{query && ' found'}</span><span><LockKeyhole size={13} /> PRIVATE REPOSITORY</span></div>
              </section>
              <div className="api-note"><Info size={15} /><span>Files are read directly from GitHub. The Contents API supports individual files up to 100 MB and returns at most 1,000 directory entries.</span></div>
            </>
          )}
          <footer className="page-footer"><span>MADE FOR YOUR PEACE OF MIND</span><span>POWERED BY GITHUB <Github size={14} /></span></footer>
        </section>
      </main>

      {settingsOpen && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setSettingsOpen(false) }}>
        <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <div className="modal-header"><span className="modal-icon"><Settings size={19} /></span><button className="icon-button" aria-label="Close settings" onClick={() => setSettingsOpen(false)}><X size={19} /></button></div>
          <span className="eyebrow">CONNECTION SETTINGS</span><h2 id="settings-title">Connect your repository</h2><p className="modal-subtitle">Your credentials are only used to make requests from this browser.</p>
          <form onSubmit={event => void connect(event)}>
            <label className="field-label">GitHub username<input required autoComplete="username" placeholder="octocat" value={form.username} onChange={event => setForm({ ...form, username: event.target.value })} /></label>
            <div className="field-pair"><label className="field-label">Repository owner<input required placeholder="octocat" value={form.owner} onChange={event => setForm({ ...form, owner: event.target.value })} /></label><label className="field-label">Repository name<input required placeholder="my-private-files" value={form.repo} onChange={event => setForm({ ...form, repo: event.target.value })} /></label></div>
            <label className="field-label">Branch<input required placeholder="main" value={form.branch} onChange={event => setForm({ ...form, branch: event.target.value })} /></label>
            <label className="field-label">Fine-grained personal access token<input required type="password" autoComplete="off" placeholder="github_pat_…" value={form.token} onChange={event => setForm({ ...form, token: event.target.value })} /></label>
            <div className="token-hint"><ShieldCheck size={16} /><span>Grant access to this repository only, with <b>Contents: Read and write</b> permission. Your username field must match the token owner.</span></div>
            <button className="button primary connect-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Github size={17} />}{busy ? 'Validating access…' : 'Validate & connect'}</button>
          </form>
          {config && <button className="disconnect-button" onClick={disconnect}><X size={15} /> Disconnect and clear token</button>}
          <div className="modal-security"><LockKeyhole size={14} /> Your token is saved in this browser's local storage and cleared when you disconnect. Anyone with access to this browser can inspect or use it.</div>
        </section>
      </div>}

      {preview && <div className="modal-backdrop preview-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) { URL.revokeObjectURL(preview.url); setPreview(null) } }}>
        <section className="preview-modal" role="dialog" aria-modal="true" aria-labelledby="preview-title">
          <div className="preview-header"><span className="preview-file-icon">{fileIcon(preview.entry.name, 18)}</span><div><strong id="preview-title">{preview.entry.name}</strong><small>{formatBytes(preview.entry.size)} · {config?.owner}/{config?.repo}</small></div><div className="preview-actions"><button className="row-action" title="Download" onClick={() => void downloadFile(preview.entry)}><Download size={17} /></button><button className="row-action" title="Close preview" onClick={() => { URL.revokeObjectURL(preview.url); setPreview(null) }}><X size={19} /></button></div></div>
          <div className="preview-body">
            {preview.text !== undefined ? <pre className="text-preview">{preview.text}</pre> : preview.url && preview.entry.name.match(/\.(png|jpe?g|gif|webp|svg|avif)$/i) ? <img className="image-preview" src={preview.url} alt={preview.entry.name} /> : preview.entry.name.match(/\.pdf$/i) ? <iframe className="document-preview" src={preview.url} title={preview.entry.name} /> : <div className="unsupported-preview"><span className="empty-icon">{fileIcon(preview.entry.name, 23)}</span><strong>Preview isn’t available for this file</strong><p>Download the file to open it on your device.</p><button className="button primary" onClick={() => void downloadFile(preview.entry)}><Download size={16} /> Download file</button></div>}
          </div>
        </section>
      </div>}
      {previewLoading && <div className="preview-loading" role="status"><LoaderCircle className="spin" size={19} /> Loading preview…</div>}
    </div>
  )
}

export default App

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

class UserFacingError extends Error {}

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
    return { config: null, error: 'A böngésző tárhelye nem érhető el, ezért a kapcsolati beállítások nem állíthatók vissza.' }
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
    return { config: null, error: 'A mentett kapcsolati beállítások érvénytelenek, és nem sikerült törölni őket a böngésző tárhelyéről.' }
  }
  return { config: null, error: 'A mentett kapcsolati beállítások érvénytelenek voltak, ezért töröltük őket.' }
}

function apiError(status: number) {
  if (status === 401) return 'A hozzáférési token érvénytelen. Ellenőrizd, hogy a finomszemcsés token aktív-e.'
  if (status === 403) return 'A GitHub megtagadta a hozzáférést. Ellenőrizd az adattár jogosultságait és az API-korlátokat.'
  if (status === 404) return 'Az adattár, az ág vagy a fájl nem található. Ellenőrizd a beállításokat, majd próbáld újra.'
  if (status === 409) return 'A fájl időközben megváltozott a GitHubon. Frissítsd a mappát, majd próbáld újra.'
  if (status === 422) return 'A GitHub nem tudta feldolgozni a kérést. Ellenőrizd a megadott adatokat és a jogosultságokat.'
  if (status === 429) return 'Túl sok kérést küldtél a GitHubnak. Várj egy kicsit, majd próbáld újra.'
  return `A GitHub API-kérése nem sikerült (${status}).`
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof UserFacingError) return error.message
  if (error instanceof TypeError) return 'A kérés nem sikerült. Ellenőrizd az internetkapcsolatot, majd próbáld újra.'
  return fallback
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
    if (!config) throw new UserFacingError('Először csatlakoztass egy adattárat a Beállításokban.')
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
      throw new UserFacingError(apiError(response.status))
    }
    return response
  }

  const contentsUrl = (filePath = '') => {
    if (!config) throw new UserFacingError('Először csatlakoztass egy adattárat a Beállításokban.')
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
        throw new UserFacingError(apiError(response.status))
      }
      const data = await response.json() as Array<{ name: string; path: string; sha: string; size: number; type: string; download_url?: string }>
      if (!Array.isArray(data)) throw new UserFacingError('A GitHub fájlt adott vissza a mappa tartalma helyett.')
      setEntries(data.map(item => ({ name: item.name, path: item.path, sha: item.sha, size: item.size, type: item.type === 'dir' ? 'dir' : 'file', download_url: item.download_url })))
      setPath(folder)
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error, 'A mappa betöltése nem sikerült.') })
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
      setNotice({ kind: 'error', text: 'A csatlakozáshoz tölts ki minden mezőt.' })
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${next.token}`, 'X-GitHub-Api-Version': '2022-11-28' }
      const userResponse = await fetch(`${API}/user`, { headers })
      if (!userResponse.ok) throw new UserFacingError(apiError(userResponse.status))
      const user = await userResponse.json() as { login: string }
      if (user.login.toLowerCase() !== next.username.toLowerCase()) {
        throw new UserFacingError(`A token a(z) @${user.login} felhasználóhoz tartozik, nem a(z) @${next.username} felhasználóhoz.`)
      }
      const repoResponse = await fetch(`${API}/repos/${encodeURIComponent(next.owner)}/${encodeURIComponent(next.repo)}`, { headers })
      if (!repoResponse.ok) throw new UserFacingError(apiError(repoResponse.status))
      const repoData = await repoResponse.json() as { private: boolean; default_branch: string }
      if (!repoData.private) throw new UserFacingError('Ez az adattár nyilvános. Csatlakozáshoz válassz privát adattárat.')
      const branchResponse = await fetch(`${API}/repos/${encodeURIComponent(next.owner)}/${encodeURIComponent(next.repo)}/branches/${encodeURIComponent(next.branch)}`, { headers })
      if (!branchResponse.ok) throw new UserFacingError(apiError(branchResponse.status))
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      setConfig(next)
      setConnected(true)
      setPath('')
      setSettingsOpen(false)
      setNotice({ kind: 'success', text: `Sikeresen csatlakoztál ehhez az adattárhoz: ${next.owner}/${next.repo}${repoData.private ? ' · Privát adattár' : ''}.` })
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error, 'A GitHub-hozzáférés ellenőrzése nem sikerült.') })
    } finally {
      setBusy(false)
    }
  }

  const disconnect = () => {
    let storageError: string | null = null
    try {
      window.localStorage.removeItem(STORAGE_KEY)
    } catch {
      storageError = ' A mentett tokent nem sikerült törölni a böngésző tárhelyéről, ezért újratöltés után ismét megjelenhet.'
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
      ? { kind: 'error', text: `Ezen az oldalon megszakadt a kapcsolat.${storageError}` }
      : { kind: 'success', text: 'A kapcsolat megszakadt, a mentett tokent töröltük ebből a böngészőből.' })
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
      setNotice({ kind: 'error', text: errorMessage(error, 'A letöltés nem sikerült.') })
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
      setNotice({ kind: 'error', text: errorMessage(error, 'Az előnézet betöltése nem sikerült.') })
    } finally {
      setPreviewLoading(false)
    }
  }

  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length || !config) return
    setUploading(true)
    setUploadProgress(`${files.length} ${files.length === 1 ? 'fájl előkészítése' : 'fájl előkészítése'}…`)
    setNotice(null)
    let completed = 0
    try {
      const selectedFiles = Array.from(files)
      for (const [index, file] of selectedFiles.entries()) {
        setUploadProgress(`${index + 1}/${selectedFiles.length}. fájl feltöltése: ${file.name}`)
        if (file.size > MAX_CONTENT_SIZE) throw new UserFacingError(`A(z) ${file.name} mérete meghaladja a GitHub Contents API 100 MB-os korlátját.`)
        const target = [path, file.name].filter(Boolean).join('/')
        const existingResponse = await fetch(contentsUrl(target), {
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${config.token}`, 'X-GitHub-Api-Version': '2022-11-28' },
        })
        let existingSha: string | undefined
        if (existingResponse.ok) {
          const existing = await existingResponse.json() as { type?: string; sha?: string }
          if (existing.type !== 'file' || !existing.sha) throw new UserFacingError(`A(z) ${file.name} nem cserélhető le: egy mappa már ezt a nevet használja.`)
          if (!window.confirm(`A(z) „${file.name}” már létezik. Lecseréled a(z) ${config.branch} ágon?`)) continue
          existingSha = existing.sha
        } else if (existingResponse.status !== 404) {
          throw new UserFacingError(apiError(existingResponse.status))
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
          body: JSON.stringify({ message: `${existingSha ? 'Frissítés' : 'Feltöltés'}: ${file.name}`, content, branch: config.branch, ...(existingSha ? { sha: existingSha } : {}) }),
        })
        completed += 1
      }
      await loadFolder(path)
      setNotice({ kind: 'success', text: completed ? `Sikeresen feltöltött vagy frissített fájlok száma: ${completed}.` : 'Nem történt fájlfeltöltés.' })
    } catch (error) {
      setNotice({ kind: 'error', text: `${completed ? `${completed} fájl feltöltése sikerült. ` : ''}${errorMessage(error, 'A feltöltés nem sikerült.')}` })
    } finally {
      setUploading(false)
      setUploadProgress('')
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const deleteFile = async (entry: Entry) => {
    if (!config || !window.confirm(`Véglegesen törlöd a(z) „${entry.name}” fájlt innen: ${config.owner}/${config.repo}? Ez egy módosítást hoz létre a(z) ${config.branch} ágon.`)) return
    setBusy(true)
    setNotice(null)
    try {
      await request(contentsUrl(entry.path), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `Törlés: ${entry.name}`, sha: entry.sha, branch: config.branch }),
      })
      setEntries(current => current.filter(item => item.path !== entry.path))
      setNotice({ kind: 'success', text: `A(z) ${entry.name} fájl törölve.` })
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error, 'A törlés nem sikerült.') })
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
      const subject = encodeURIComponent(`Fájl megosztása: ${entry.name}`)
      const body = encodeURIComponent(`Csatoltam a fájlt: „${entry.name}”.

Szerzői jogi tájékoztató:
Ez a mű eredeti alkotás. Minden jog fenntartva.
A mű sokszorosítása, továbbterjesztése, módosítása vagy kereskedelmi célú felhasználása az alkotó előzetes írásos engedélye nélkül tilos.

Kérjük, engedély nélkül ne töltsd fel, ne oszd meg és ne add hozzá ezt a művet más platformokhoz vagy adattárakhoz.

Köszönjük, hogy tiszteletben tartod az alkotó munkáját.`)
      window.location.href = `mailto:?subject=${subject}&body=${body}`
      setNotice({ kind: 'success', text: 'A fájl letöltődött. A megosztáshoz csatold a piszkozatként megnyitott e-mailhez.' })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return
      setNotice({ kind: 'error', text: errorMessage(error, 'A megosztás nem sikerült.') })
    }
  }

  const printFile = async (entry: Entry) => {
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1
    if (!isMobile) {
      const blobUrl = config ? `https://github.com/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/blob/${encodeURIComponent(config.branch)}/${entry.path.split('/').map(encodeURIComponent).join('/')}` : ''
      window.open(blobUrl, '_blank', 'noopener,noreferrer')
      setNotice({ kind: 'success', text: 'A GitHub új lapon nyílt meg. Privát fájl megtekintéséhez GitHub-hitelesítés és adattár-hozzáférés szükséges. A hitelesített eléréshez használd itt az Előnézet vagy a Letöltés lehetőséget.' })
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
        setNotice({ kind: 'success', text: 'A böngésző letiltotta az új lap megnyitását, ezért a hitelesítést igénylő fájl letöltődött.' })
      }
    } catch (error) {
      opened?.close()
      setNotice({ kind: 'error', text: errorMessage(error, 'A fájl megnyitása nem sikerült.') })
    }
  }

  const breadcrumbs = ['', ...path.split('/').filter(Boolean)]

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={event => event.preventDefault()}>
          <span className="brand-mark"><HardDrive size={20} /></span>
          <span>vault<span className="brand-dot">.</span><small>PRIVÁT FÁJLOK</small></span>
        </a>
        <div className="side-label">MUNKATERÜLET</div>
        <button className={`nav-item ${activeTab === 'files' ? 'active' : ''}`} onClick={() => { setActiveTab('files'); setPath(''); if (config) void loadFolder('', config) }}>
          <LayoutGrid size={18} /> Fájlböngésző
        </button>
        {connected && <button className={`nav-item ${activeTab === 'anatomy' ? 'active' : ''}`} onClick={() => setActiveTab('anatomy')}>
          <Activity size={18} /> 3D anatómia
        </button>}
        <button className="nav-item" onClick={() => setSettingsOpen(true)}><Settings size={18} /> Beállítások</button>
        <div className="sidebar-bottom">
          <div className="secure-card">
            <span className="secure-icon"><ShieldCheck size={17} /></span>
            <strong>A fájljaid csak a tieid</strong>
            <p>A kapcsolat beállításait ez a böngésző menti, nem egy kiszolgáló.</p>
            <span className="security-status"><span /> TITKOSÍTOTT KAPCSOLAT</span>
          </div>
          <div className="profile">
            <span className="avatar">{config?.username?.slice(0, 1).toUpperCase() ?? <Github size={17} />}</span>
            <span className="profile-label"><strong>{config ? `@${config.username}` : 'Nincs kapcsolat'}</strong><small>{config ? `${config.owner}/${config.repo}` : 'Csatlakoztass egy adattárat'}</small></span>
            <button className="icon-button" aria-label="Beállítások megnyitása" onClick={() => setSettingsOpen(true)}><MoreHorizontal size={19} /></button>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="mobile-brand"><span className="brand-mark"><HardDrive size={18} /></span><b>vault<span className="brand-dot">.</span></b></div>
          <div className="top-context"><span className="context-dot" /> PRIVÁT MUNKATERÜLET <ChevronRight size={14} /> <span>{activeTab === 'anatomy' ? '3D anatómia' : 'Fájlböngésző'}</span></div>
          <div className="top-actions"><span className="online-pill"><span /> BIZTONSÁGOS MUNKAMENET</span><button className="icon-button settings-shortcut" aria-label="Beállítások" onClick={() => setSettingsOpen(true)}><Settings size={19} /></button></div>
        </header>
        {connected && <nav className="mobile-nav" aria-label="Munkaterület lapjai">
          <button className={activeTab === 'files' ? 'active' : ''} aria-pressed={activeTab === 'files'} onClick={() => { setActiveTab('files'); setPath(''); if (config) void loadFolder('', config) }}>
            <LayoutGrid size={16} /> Fájlböngésző
          </button>
          <button className={activeTab === 'anatomy' ? 'active' : ''} aria-pressed={activeTab === 'anatomy'} onClick={() => setActiveTab('anatomy')}>
            <Activity size={16} /> 3D anatómia
          </button>
        </nav>}

        <section className="content">
          {activeTab === 'files' && <div className="page-heading">
            <div><div className="eyebrow">A SAJÁT FELHŐD</div><h1>Fájlböngésző<span className="heading-period">.</span></h1><p className="subtitle">Nyugodt hely a fontos fájljaidnak.</p></div>
            <div className="heading-actions">
              {config && <button className="button secondary" onClick={() => void loadFolder(path)} disabled={busy}><ArrowUpDown size={16} /> Frissítés</button>}
              <button className="button primary" onClick={() => config ? fileInput.current?.click() : setSettingsOpen(true)} disabled={uploading}>
                {uploading ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />} {uploading ? uploadProgress || 'Feltöltés…' : 'Fájlok feltöltése'}
              </button>
              <input ref={fileInput} type="file" multiple hidden onChange={event => void uploadFiles(event.target.files)} />
            </div>
          </div>}

          {notice && <div className={`notice ${notice.kind}`} role="status"><span>{notice.kind === 'error' ? <Info size={17} /> : <Check size={17} />}{notice.text}</span><button aria-label="Értesítés bezárása" onClick={() => setNotice(null)}><X size={16} /></button></div>}

          {!connected ? (
            <section className="welcome-card">
              <div className="welcome-graphic"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="welcome-icon"><LockKeyhole size={26} /></div><div className="float-chip chip-one"><Github size={16} /></div><div className="float-chip chip-two"><ShieldCheck size={16} /></div></div>
              <div className="welcome-copy"><span className="eyebrow">PRIVÁT ADATTÁR, PRIVÁT MŰKÖDÉS</span><h2>A fájljaid, a te adattárad.</h2><p>Csatlakoztass egy privát GitHub-adattárat, hogy bármilyen eszközről böngészhesd, megtekinthesd és kezelhesd a fájljaidat. A hozzáférési tokenedet ez a böngésző menti, így újratöltés után is kapcsolatban maradsz.</p><button className="button primary" onClick={() => setSettingsOpen(true)}><Github size={17} /> Adattár csatlakoztatása <ChevronRight size={16} /></button><div className="welcome-points"><span><Check size={14} /> Nincs szerveroldali tárolás</span><span><Check size={14} /> Finomszemcsés token</span></div></div>
            </section>
          ) : activeTab === 'anatomy' ? (
            <section className="anatomy-page">
              <div className="anatomy-hero">
                <div className="anatomy-copy">
                  <span className="anatomy-kicker"><span /> AZ EMBERI TEST ÚJ MEGKÖZELÍTÉSBEN</span>
                  <h1>Fedezd fel az anatómiát<br /><span>új dimenzióban.</span></h1>
                  <p>Lépj be egy magával ragadó, 3D-s anatómiai élménybe. Forgasd, nagyítsd, és fedezd fel a testet minden oldalról.</p>
                  <a className="anatomy-launch" href="https://jintai3d.com/viewer/?model=z-anatomy" target="_blank" rel="noopener noreferrer">
                    <ScanLine size={18} /> 3D anatómia megnyitása <ArrowUpRight size={17} />
                  </a>
                  <div className="anatomy-note"><span className="anatomy-note-line" /> Az interaktív nézet új lapon nyílik meg</div>
                </div>
                <div className="anatomy-art" aria-label="Stilizált anatómiai ábra">
                  <div className="anatomy-orbit anatomy-orbit-one" />
                  <div className="anatomy-orbit anatomy-orbit-two" />
                  <span className="anatomy-coordinate coordinate-top">1. ÁBRA <i>—</i> EMBER</span>
                  <span className="anatomy-coordinate coordinate-bottom">INTERAKTÍV <i>·</i> 3D MODELL</span>
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
                  <span className="anatomy-callout callout-one"><span /> MOZGÁSSZERVRENDSZER</span>
                  <span className="anatomy-callout callout-two"><span /> EMBERI TEST</span>
                </div>
              </div>
              <div className="anatomy-bottom">
                <div><span className="anatomy-bottom-icon"><ScanLine size={18} /></span><span><strong>Nézd meg közelebbről</strong><small>Fedezd fel a testet 3D-ben</small></span></div>
                <div><span className="anatomy-bottom-icon"><Activity size={18} /></span><span><strong>Tanulj felfedezéssel</strong><small>Járd be az emberi testet</small></span></div>
                <span className="anatomy-credit">A JINTAI 3D KÖZREMŰKÖDÉSÉVEL <ArrowUpRight size={13} /></span>
              </div>
            </section>
          ) : (
            <>
              <section className="repo-strip">
                <span className="repo-icon"><Github size={19} /></span>
                <div className="repo-detail"><strong>{config?.owner}/{config?.repo}</strong><span><span className="private-badge"><LockKeyhole size={11} /> PRIVÁT</span><span className="branch-label">Ág: <b>{config?.branch}</b></span></span></div>
                <button className="repo-settings" onClick={() => setSettingsOpen(true)}><Settings size={15} /> Adattár beállításai</button>
              </section>
              <section className="file-panel">
                <div className="file-toolbar">
                  <div className="breadcrumbs" aria-label="Útvonalmorzsák">
                    {breadcrumbs.map((crumb, index) => <span key={`${crumb}-${index}`}><button className={index === breadcrumbs.length - 1 ? 'crumb current' : 'crumb'} onClick={() => void loadFolder(breadcrumbs.slice(1, index + 1).join('/'))}>{index === 0 ? <FolderOpen size={16} /> : crumb}</button>{index < breadcrumbs.length - 1 && <ChevronRight size={14} />}</span>)}
                  </div>
                  <div className="file-tools"><label className="search-box"><Search size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Fájlok keresése…" /><kbd>⌘ K</kbd></label><button className={`view-button ${view === 'list' ? 'selected' : ''}`} aria-label="Listanézet" onClick={() => setView('list')}><List size={17} /></button><button className={`view-button ${view === 'grid' ? 'selected' : ''}`} aria-label="Rácsnézet" onClick={() => setView('grid')}><Grid2X2 size={16} /></button></div>
                </div>
                <div className={`file-table ${view}`}>
                  <div className="table-head"><span><button className="sort-control" onClick={() => { setSortBy('name'); setDescending(sortBy === 'name' ? !descending : false) }}>NÉV <ArrowDownAZ size={14} /></button></span><span><button className="sort-control size-sort" onClick={() => { setSortBy('size'); setDescending(sortBy === 'size' ? !descending : false) }}>MÉRET <ArrowUpDown size={13} /></button></span><span>LEGUTÓBBI MÓDOSÍTÁS</span><span /></div>
                  {busy && entries.length === 0 ? <div className="loading-state"><LoaderCircle className="spin" size={21} /> Kapcsolódás a GitHubhoz…</div> :
                    visibleEntries.length === 0 ? <div className="empty-state"><span className="empty-icon"><Folder size={22} /></span><strong>{query ? 'Nincs találat' : 'Ez a mappa üres'}</strong><p>{query ? 'Próbálj másik keresőkifejezést.' : 'Kezdésként tölts fel egy fájlt.'}</p>{!query && <button className="text-button" onClick={() => fileInput.current?.click()}><Plus size={15} /> Fájl feltöltése</button>}</div> :
                      visibleEntries.map(entry => <div className="file-row" key={entry.path}>
                        <button className="file-main" onClick={() => entry.type === 'dir' ? void loadFolder(entry.path) : void openPreview(entry)}>
                          <span className={`file-icon ${entry.type === 'dir' ? 'folder-color' : ''}`}>{entry.type === 'dir' ? <Folder size={19} fill="currentColor" /> : fileIcon(entry.name)}</span>
                          <span className="file-name">{entry.name}</span>{entry.type === 'dir' && <ChevronRight className="row-chevron" size={15} />}
                        </button>
                        <span className="file-size">{entry.type === 'dir' ? '—' : formatBytes(entry.size)}</span><span className="commit-label">—</span>
                        <div className="row-actions">
                          {entry.type === 'file' && <><button className="row-action" title="Előnézet" aria-label={`Előnézet: ${entry.name}`} onClick={() => void openPreview(entry)}><PanelTop size={16} /></button><button className="row-action" title="Letöltés" aria-label={`Letöltés: ${entry.name}`} onClick={() => void downloadFile(entry)}><Download size={16} /></button><button className="row-action" title="Megosztás" aria-label={`Megosztás: ${entry.name}`} onClick={() => void shareFile(entry)}><Share2 size={16} /></button><button className="row-action" title="Nyomtatás / megnyitás" aria-label={`Nyomtatás vagy megnyitás: ${entry.name}`} onClick={() => void printFile(entry)}><Printer size={16} /></button></>}
                          {entry.type === 'file' && <button className="row-action delete-action" title="Törlés" aria-label={`Törlés: ${entry.name}`} onClick={() => void deleteFile(entry)}><Trash2 size={16} /></button>}
                        </div>
                      </div>)}
                  {busy && entries.length > 0 && <div className="inline-loading"><LoaderCircle className="spin" size={15} /> Frissítés…</div>}
                </div>
                <div className="panel-footer"><span><span className="footer-dot" /> {visibleEntries.length} {visibleEntries.length === 1 ? 'elem' : 'elem'}{query && ' találat'}</span><span><LockKeyhole size={13} /> PRIVÁT ADATTÁR</span></div>
              </section>
              <div className="api-note"><Info size={15} /><span>A fájlok közvetlenül a GitHubról érkeznek. A Contents API legfeljebb 100 MB-os fájlokat és mappánként legfeljebb 1000 elemet támogat.</span></div>
            </>
          )}
          <footer className="page-footer"><span>A NYUGALMADÉRT KÉSZÜLT</span><span>A GITHUB KÖZREMŰKÖDÉSÉVEL <Github size={14} /></span></footer>
        </section>
      </main>

      {settingsOpen && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setSettingsOpen(false) }}>
        <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <div className="modal-header"><span className="modal-icon"><Settings size={19} /></span><button className="icon-button" aria-label="Beállítások bezárása" onClick={() => setSettingsOpen(false)}><X size={19} /></button></div>
          <span className="eyebrow">KAPCSOLATI BEÁLLÍTÁSOK</span><h2 id="settings-title">Adattár csatlakoztatása</h2><p className="modal-subtitle">A hitelesítési adataidat csak ez a böngésző használja a kérésekhez.</p>
          <form onSubmit={event => void connect(event)}>
            <label className="field-label">GitHub-felhasználónév<input required autoComplete="username" placeholder="octocat" value={form.username} onChange={event => setForm({ ...form, username: event.target.value })} /></label>
            <div className="field-pair"><label className="field-label">Az adattár tulajdonosa<input required placeholder="octocat" value={form.owner} onChange={event => setForm({ ...form, owner: event.target.value })} /></label><label className="field-label">Az adattár neve<input required placeholder="sajat-privat-fajlok" value={form.repo} onChange={event => setForm({ ...form, repo: event.target.value })} /></label></div>
            <label className="field-label">Ág<input required placeholder="main" value={form.branch} onChange={event => setForm({ ...form, branch: event.target.value })} /></label>
            <label className="field-label">Finomszemcsés személyes hozzáférési token<input required type="password" autoComplete="off" placeholder="github_pat_…" value={form.token} onChange={event => setForm({ ...form, token: event.target.value })} /></label>
            <div className="token-hint"><ShieldCheck size={16} /><span>Csak ehhez az adattárhoz adj hozzáférést, <b>Tartalom: olvasási és írási</b> jogosultsággal. A felhasználónév mezőben a token tulajdonosának nevét add meg.</span></div>
            <button className="button primary connect-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Github size={17} />}{busy ? 'Hozzáférés ellenőrzése…' : 'Ellenőrzés és csatlakozás'}</button>
          </form>
          {config && <button className="disconnect-button" onClick={disconnect}><X size={15} /> Kapcsolat bontása és token törlése</button>}
          <div className="modal-security"><LockKeyhole size={14} /> A tokent a böngésző helyi tárhelye menti, és a kapcsolat bontásakor törlődik. A böngészőhöz hozzáférők megtekinthetik vagy használhatják.</div>
        </section>
      </div>}

      {preview && <div className="modal-backdrop preview-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) { URL.revokeObjectURL(preview.url); setPreview(null) } }}>
        <section className="preview-modal" role="dialog" aria-modal="true" aria-labelledby="preview-title">
          <div className="preview-header"><span className="preview-file-icon">{fileIcon(preview.entry.name, 18)}</span><div><strong id="preview-title">{preview.entry.name}</strong><small>{formatBytes(preview.entry.size)} · {config?.owner}/{config?.repo}</small></div><div className="preview-actions"><button className="row-action" title="Letöltés" onClick={() => void downloadFile(preview.entry)}><Download size={17} /></button><button className="row-action" title="Előnézet bezárása" onClick={() => { URL.revokeObjectURL(preview.url); setPreview(null) }}><X size={19} /></button></div></div>
          <div className="preview-body">
            {preview.text !== undefined ? <pre className="text-preview">{preview.text}</pre> : preview.url && preview.entry.name.match(/\.(png|jpe?g|gif|webp|svg|avif)$/i) ? <img className="image-preview" src={preview.url} alt={preview.entry.name} /> : preview.entry.name.match(/\.pdf$/i) ? <iframe className="document-preview" src={preview.url} title={preview.entry.name} /> : <div className="unsupported-preview"><span className="empty-icon">{fileIcon(preview.entry.name, 23)}</span><strong>Ehhez a fájlhoz nem érhető el előnézet.</strong><p>Nyisd meg a fájlt az eszközödön a letöltés után.</p><button className="button primary" onClick={() => void downloadFile(preview.entry)}><Download size={16} /> Fájl letöltése</button></div>}
          </div>
        </section>
      </div>}
      {previewLoading && <div className="preview-loading" role="status"><LoaderCircle className="spin" size={19} /> Előnézet betöltése…</div>}
    </div>
  )
}

export default App

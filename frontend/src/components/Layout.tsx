import { Link, Outlet } from 'react-router-dom'

export default function Layout() {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-3">
        <Link to="/projects" className="text-sm font-semibold tracking-wide text-zinc-100 hover:text-white">
          pdf_to_lean
        </Link>
        <Link to="/dev/settings" className="text-xs text-amber-500/70 hover:text-amber-300">
          API settings
        </Link>
      </header>
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}

import { Link, Outlet } from 'react-router-dom'

export default function Layout() {
  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden">
      <header className="border-b border-[rgba(99,86,70,0.16)] bg-[rgba(255,250,242,0.78)] px-6 py-4 shadow-[0_8px_30px_rgba(58,40,10,0.05)] backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between">
          <Link to="/projects" className="text-sm font-extrabold tracking-wide text-[var(--ink)] hover:text-[var(--accent)]">
            Autoformalization Benchmark
          </Link>
          <Link to="/dev/settings" className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--accent)] hover:text-[#8f2d18]">
            API settings
          </Link>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}

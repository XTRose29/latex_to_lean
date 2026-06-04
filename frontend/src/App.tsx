import { Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import ProjectsPage from './pages/ProjectsPage'
import NewProjectPage from './pages/NewProjectPage'
import JobPage from './pages/JobPage'
import DevSettingsPage from './pages/DevSettingsPage'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Navigate to="/projects" replace />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/new" element={<NewProjectPage />} />
        <Route path="jobs/:jobId" element={<JobPage />} />
        <Route path="dev/settings" element={<DevSettingsPage />} />
      </Route>
    </Routes>
  )
}

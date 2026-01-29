import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import JoinRoom from './components/JoinRoom'
import Workspace from './components/Workspace'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/room/demo" replace />} />
        <Route path="/room/:roomId" element={<JoinRoom />} />
        <Route path="/workspace/:roomId" element={<Workspace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App

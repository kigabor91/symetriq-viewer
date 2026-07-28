import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Configs } from '@xeokit/xeokit-sdk'
import './index.css'
import App from './App.tsx'

// IFC geometry is rebased to a local project origin by the converter. Avoid
// xeokit's fp64 render path before any Viewer is created to save GPU memory and
// arithmetic on large federated models.
class SymetriqXeokitConfigs extends Configs {}
new SymetriqXeokitConfigs().doublePrecisionEnabled = false

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

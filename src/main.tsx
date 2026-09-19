import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './DesktopSetupView.css';
import './DesktopRuntimeSetupView.css';
import './DesktopMcpView.css';
import './styles.css';
import './artifact-previews.css';
import './readability.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

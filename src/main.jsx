import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App, { AppErrorBoundary } from './App.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { SchoolDataProvider } from './context/SchoolDataContext.jsx';
import { ThemeProvider } from './context/ThemeContext.jsx';
import { ToastProvider } from './components/ui/Toast.jsx';
import { installOfflineQueueAutoFlush } from './services/database/dbFallback.js';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root element in index.html');

/**
 * Drains any write that failed while offline as soon as the browser reconnects
 * (in insertion order, once each). Installed before the first render so a queue left
 * behind by the previous session is replayed even if this visit never edits anything.
 */
installOfflineQueueAutoFlush();

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <ThemeProvider>
        <BrowserRouter>
          <AuthProvider>
            <SchoolDataProvider>
              <ToastProvider>
                <App />
              </ToastProvider>
            </SchoolDataProvider>
          </AuthProvider>
        </BrowserRouter>
      </ThemeProvider>
    </AppErrorBoundary>
  </React.StrictMode>,
);


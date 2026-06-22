import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, info: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    this.setState({ info });
    console.error('[GlobalErrorBoundary] Caught render error:', error, info?.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 40, fontFamily: 'monospace', background: '#fff1f2', minHeight: '100vh' }}>
          <h2 style={{ color: '#b91c1c', marginBottom: 12 }}>⚠ Application Error</h2>
          <p style={{ color: '#374151', marginBottom: 8 }}><strong>Message:</strong> {String(this.state.error)}</p>
          {this.state.info && (
            <pre style={{ fontSize: 11, color: '#374151', whiteSpace: 'pre-wrap', background: '#fff', border: '1px solid #fca5a5', borderRadius: 6, padding: 12, overflowX: 'auto' }}>
              {this.state.info.componentStack}
            </pre>
          )}
          <button
            style={{ marginTop: 20, padding: '8px 20px', background: '#b91c1c', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}
            onClick={() => { this.setState({ hasError: false, error: null, info: null }); }}
          >
            Try to recover
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)

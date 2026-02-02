import EyeTracker from './components/EyeTracker';
import { SystemOverlay } from './components/overlay/SystemOverlay';

function App() {
  return (
    <SystemOverlay>
      <EyeTracker />
    </SystemOverlay>
  );
}

export default App;

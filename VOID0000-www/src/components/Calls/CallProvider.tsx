import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useCallController } from '../../Services/Calls/useCallController';
import type { CallControllerProps, CallPhase } from '../../Services/Calls/callTypes';
import CallShelf from './CallShelf';

interface CallProviderProps extends CallControllerProps {
  children: ReactNode;
}

interface CallContextValue {
  phase: CallPhase;
  busy: boolean;
  showCallShelf: boolean;
  supportsDirectCall: boolean;
  startCall: () => void;
}

const CallContext = createContext<CallContextValue | null>(null);

export function CallProvider({ children, ...controllerProps }: CallProviderProps) {
  const call = useCallController(controllerProps);
  const callShelf = call.showCallShelf ? <CallShelf {...call.shelfProps} /> : null;
  const renderedCallShelf = callShelf && typeof document !== 'undefined'
    ? createPortal(callShelf, document.body)
    : callShelf;

  return (
    <CallContext.Provider
      value={{
        phase: call.phase,
        busy: call.busy,
        showCallShelf: call.showCallShelf,
        supportsDirectCall: call.supportsDirectCall,
        startCall: call.startCall,
      }}
    >
      {children}
      <audio ref={call.remoteAudioRef} autoPlay playsInline className="hidden" />
      {renderedCallShelf}
    </CallContext.Provider>
  );
}

export function useCallContext() {
  const context = useContext(CallContext);
  if (!context) {
    throw new Error('useCallContext must be used within CallProvider');
  }
  return context;
}

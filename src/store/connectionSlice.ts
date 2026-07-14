import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export type ConnectionPhase =
  | "disconnected"
  | "connecting"
  | "initializing"
  | "ready"
  | "error";

export interface ConnectionViewState {
  phase: ConnectionPhase;
  detail: string | null;
}

export const initialConnectionState: ConnectionViewState = {
  phase: "disconnected",
  detail: null,
};

const connectionSlice = createSlice({
  name: "connection",
  initialState: initialConnectionState,
  reducers: {
    connectionViewChanged(_state, action: PayloadAction<ConnectionViewState>) {
      return action.payload;
    },
    connectionViewReset() {
      return initialConnectionState;
    },
  },
});

export const { connectionViewChanged, connectionViewReset } =
  connectionSlice.actions;
export const connectionReducer = connectionSlice.reducer;

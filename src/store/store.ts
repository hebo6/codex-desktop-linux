import { configureStore } from "@reduxjs/toolkit";

import { configurationReducer } from "./configurationSlice";
import { connectionReducer } from "./connectionSlice";

export const store = configureStore({
  reducer: {
    configuration: configurationReducer,
    connection: connectionReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export const selectConnectionView = (state: RootState) => state.connection;
export const selectConfiguration = (state: RootState) => state.configuration;

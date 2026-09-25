// Runtime config injected by the Docker entrypoint via placeholder substitution,
// falling back to build-time Vite env. Lets us toggle features without rebuild.
export const runtimeEnv = (key, buildTimeValue) => {
  if (typeof window !== 'undefined' && window.__MAXUN_RUNTIME__ && window.__MAXUN_RUNTIME__[key] !== undefined) {
    return window.__MAXUN_RUNTIME__[key];
  }
  return buildTimeValue;
};
export const isRegistrationDisabled = () => {
  const v = runtimeEnv('DISABLE_REGISTRATION', import.meta.env.VITE_DISABLE_REGISTRATION);
  return v === 'true' || v === true;
};

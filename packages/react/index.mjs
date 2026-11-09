import { profile } from './profile.mjs';

/** The react pack. `profile` is a function returning the profile config, loaded only when the command runs. */
export function reactPack({ profile: load } = {}) {
  if (load !== undefined && typeof load !== 'function')
    throw new TypeError(
      'reactPack: profile must be a function returning the profile config',
    );
  return {
    name: 'react',
    version: '0.0.0-local',
    packCommands:
      load === undefined
        ? {}
        : {
            profile: async (args) => {
              try {
                await profile(await load()).run(args);
              } catch (err) {
                console.error(err);
                return 1;
              }
              return process.exitCode ?? 0;
            },
          },
  };
}

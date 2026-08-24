export const BeepPlugin = async ({ $ }) => {
  return {
    "session.idle": async () => {
      await $`paplay /usr/share/sounds/freedesktop/stereo/complete.oga`.nothrow()
    },
  }
}

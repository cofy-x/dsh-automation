export function profile(args: readonly string[]): string {
  const index = args.indexOf('--profile')
  const assigned = args.find(argument => argument.startsWith('--profile='))
  if (index < 0 && assigned === undefined) return 'automation'
  if (assigned !== undefined) {
    const value = assigned.slice('--profile='.length)
    if (value.trim() === '') throw new Error('--profile requires a value')
    return value
  }
  const value = args[index + 1]
  if (value === undefined || value.trim() === '') throw new Error('--profile requires a value')
  return value
}

export function withoutProfile(args: readonly string[]): string[] {
  const index = args.indexOf('--profile')
  if (index < 0) return args.filter(argument => !argument.startsWith('--profile='))
  return args.filter((argument, current) => {
    if (argument.startsWith('--profile=')) return false
    return current !== index && current !== index + 1
  })
}

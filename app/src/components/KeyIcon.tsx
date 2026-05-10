type KeyIconProps = {
  /** Last few characters of the Swarm root hex (no label — used only to pick a stable hue). */
  hueSeed: string
}

/** Key glyph + hue derived from a short string (e.g. last 6 hex chars of the Swarm manifest root). */
export function KeyIcon({ hueSeed }: KeyIconProps) {
  const generateColor = (str: string) => {
    const sum = str.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
    const hue = sum % 360
    return `hsl(${hue}, 70%, 50%)`
  }

  const color = generateColor(hueSeed)

  return (
    <svg
      width={36}
      height={36}
      viewBox="0 0 24 24"
      style={{ color }}
      className="transition-colors duration-200"
      aria-hidden
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M6 8C4.34315 8 3 9.34315 3 11V13C3 14.6569 4.34315 16 6 16C7.65685 16 9 14.6569 9 13H15V15H17V13H18V15H20V11H9C9 9.34315 7.65685 8 6 8ZM7 13V11C7 10.4477 6.55228 10 6 10C5.44772 10 5 10.4477 5 11V13C5 13.5523 5.44772 14 6 14C6.55228 14 7 13.5523 7 13Z"
      />
    </svg>
  )
}

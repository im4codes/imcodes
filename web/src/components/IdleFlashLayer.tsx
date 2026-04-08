interface Props {
  variant: 'frame' | 'fill';
}

export function IdleFlashLayer({ variant }: Props) {
  return <span aria-hidden="true" class={`idle-flash-layer idle-flash-layer--${variant}`} />;
}

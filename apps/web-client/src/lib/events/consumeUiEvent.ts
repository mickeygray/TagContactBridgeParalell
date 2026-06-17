type ConsumableUiEvent = {
  preventDefault?: () => void;
  stopPropagation?: () => void;
};

export function consumeUiEvent(event: ConsumableUiEvent | null | undefined): void {
  event?.preventDefault?.();
  event?.stopPropagation?.();
}

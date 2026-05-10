import { Info, User } from 'lucide-react'
import { Button } from './ui/button'
import { cn } from '../lib/cn'
import type { AppRoute } from '../routing'
import type { Address } from 'viem'

type Props = {
  route: AppRoute
  onNavigate: (route: AppRoute) => void
  address: Address | null
  walletReady: boolean
  canUseWallet: boolean
  onConnectWallet: () => void
  swarmReady: boolean
  canUseSwarm: boolean
  onConnectSwarm: () => void
  profileNavEnabled: boolean
  busy: boolean
}

export function AppNav({
  route,
  onNavigate,
  address,
  walletReady,
  canUseWallet,
  onConnectWallet,
  swarmReady,
  canUseSwarm,
  onConnectSwarm,
  profileNavEnabled,
  busy,
}: Props) {
  const aboutActive = route.name === 'about'

  return (
    <div className="fixed left-0 right-0 top-0 z-50 flex justify-center border-b border-border bg-background/95 shadow-sm backdrop-blur-md supports-[backdrop-filter]:bg-background/85 pt-[env(safe-area-inset-top,0px)]">
      <div className="flex w-full max-w-[500px] flex-nowrap items-center justify-center gap-1 overflow-x-auto px-2 py-3 sm:w-[500px] sm:gap-2 sm:px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <h1 className="shrink-0 font-display text-2xl tracking-tight text-foreground sm:text-3xl">/swarmkey</h1>

        <Button
          variant="outline"
          size="icon"
          disabled={!profileNavEnabled || busy}
          className={cn('shrink-0', !profileNavEnabled && 'opacity-50', route.name === 'profile' && 'border-primary')}
          onClick={() => onNavigate({ name: 'profile' })}
          aria-label="Profile"
        >
          <User className="h-[1.2rem] w-[1.2rem]" />
        </Button>

        <Button
          variant="outline"
          className="h-10 shrink-0 gap-1.5 px-2 sm:gap-2 sm:px-3"
          disabled={!canUseSwarm || busy}
          onClick={() => onConnectSwarm()}
          title={swarmReady ? 'Swarm connected' : 'Connect Swarm'}
        >
          {swarmReady ? (
            <img src="/swarm.png" alt="" className="h-5 w-5 shrink-0 object-contain" width={20} height={20} />
          ) : (
            <span className="whitespace-nowrap text-xs sm:text-sm">Swarm</span>
          )}
        </Button>

        {walletReady && address ? (
          <Button variant="outline" className="h-10 max-w-[9.5rem] shrink-0 gap-1.5 px-2 sm:max-w-none sm:px-3" disabled={busy}>
            <img src="/icons/gnosis.png" alt="" className="h-4 w-4 shrink-0 object-contain" width={16} height={16} />
            <span className="truncate text-xs sm:text-sm">
              {address.slice(0, 7)}…{address.slice(-5)}
            </span>
          </Button>
        ) : (
          <Button variant="outline" className="h-10 shrink-0 whitespace-nowrap px-2 text-xs sm:px-3 sm:text-sm" disabled={!canUseWallet || busy} onClick={() => onConnectWallet()}>
            Connect Wallet
          </Button>
        )}

        <Button
          variant="outline"
          size="icon"
          disabled={busy}
          className={cn('shrink-0', aboutActive && 'border-primary')}
          onClick={() => onNavigate({ name: 'about' })}
          aria-label="About"
          title="About"
        >
          <Info className="h-5 w-5" />
        </Button>
      </div>
    </div>
  )
}

// The thread icon and colour sets (docs/THREADS.md). `Thread.icon` holds a key from THREAD_ICONS or ART_ICONS; anything
// else (an emoji from an older config, or nothing) shows the thread's black-figure art, picked by id. `Thread.color`
// holds a THREAD_COLOR key; an unknown key renders as Default, so a newer app can add colours safely.
import type { ThreadColorKey } from '@talos-app/protocol'
import {
  Baby,
  BookOpen,
  Bot,
  Brain,
  Briefcase,
  Bug,
  Calendar,
  Camera,
  Car,
  ChartLine,
  Clock,
  Code,
  Coffee,
  Cpu,
  Dog,
  DollarSign,
  Dumbbell,
  Film,
  Flag,
  Flame,
  Gamepad2,
  Gift,
  GitBranch,
  Globe,
  GraduationCap,
  Hammer,
  Heart,
  House,
  Inbox,
  Leaf,
  Lightbulb,
  ListTodo,
  type LucideIcon,
  Mail,
  MapPin,
  Megaphone,
  MessageCircle,
  Moon,
  Music,
  NotebookPen,
  Palette,
  PawPrint,
  Pencil,
  Phone,
  Plane,
  Rocket,
  Shield,
  ShoppingCart,
  Sparkles,
  Star,
  Stethoscope,
  Sun,
  Target,
  Terminal,
  Trophy,
  User,
  Users,
  Utensils,
  Wallet,
  Wrench,
  Zap,
} from 'lucide-react'

export type GlyphIcon = { key: string; label: string; words: string; C: LucideIcon }

/** 60 line glyphs from lucide-react (ISC). Keys are part of saved configs: never rename one, only add. */
export const THREAD_ICONS: readonly GlyphIcon[] = [
  { key: 'briefcase', label: 'Briefcase', words: 'work job office', C: Briefcase },
  { key: 'hammer', label: 'Hammer', words: 'build make tools', C: Hammer },
  { key: 'wrench', label: 'Wrench', words: 'fix repair tools settings', C: Wrench },
  { key: 'code', label: 'Code', words: 'dev programming software', C: Code },
  { key: 'terminal', label: 'Terminal', words: 'shell cli dev', C: Terminal },
  { key: 'rocket', label: 'Rocket', words: 'launch ship deploy project', C: Rocket },
  { key: 'cpu', label: 'Chip', words: 'computer hardware ai', C: Cpu },
  { key: 'bug', label: 'Bug', words: 'issue debug', C: Bug },
  { key: 'git-branch', label: 'Branch', words: 'git code repo', C: GitBranch },
  { key: 'bot', label: 'Robot', words: 'ai agent automation', C: Bot },
  { key: 'brain', label: 'Brain', words: 'ideas think learn ai', C: Brain },
  { key: 'message', label: 'Chat', words: 'talk message general', C: MessageCircle },
  { key: 'mail', label: 'Mail', words: 'email letters', C: Mail },
  { key: 'phone', label: 'Phone', words: 'call', C: Phone },
  { key: 'megaphone', label: 'Megaphone', words: 'marketing announce social', C: Megaphone },
  { key: 'users', label: 'People', words: 'team family group', C: Users },
  { key: 'user', label: 'Person', words: 'me personal', C: User },
  { key: 'inbox', label: 'Inbox', words: 'tray incoming', C: Inbox },
  { key: 'calendar', label: 'Calendar', words: 'dates schedule events', C: Calendar },
  { key: 'clock', label: 'Clock', words: 'time reminders', C: Clock },
  { key: 'list-todo', label: 'To-do', words: 'tasks errands checklist', C: ListTodo },
  { key: 'target', label: 'Target', words: 'goals focus', C: Target },
  { key: 'flag', label: 'Flag', words: 'milestone priority', C: Flag },
  { key: 'trophy', label: 'Trophy', words: 'win goals', C: Trophy },
  { key: 'lightbulb', label: 'Light bulb', words: 'ideas', C: Lightbulb },
  { key: 'pencil', label: 'Pencil', words: 'write draft edit', C: Pencil },
  { key: 'notebook', label: 'Notebook', words: 'notes journal writing', C: NotebookPen },
  { key: 'book', label: 'Book', words: 'reading study', C: BookOpen },
  { key: 'graduation', label: 'School', words: 'learn study course', C: GraduationCap },
  { key: 'dollar', label: 'Money', words: 'finance budget cash', C: DollarSign },
  { key: 'wallet', label: 'Wallet', words: 'money spending', C: Wallet },
  { key: 'chart', label: 'Chart', words: 'stats growth numbers', C: ChartLine },
  { key: 'cart', label: 'Cart', words: 'shopping groceries buy', C: ShoppingCart },
  { key: 'gift', label: 'Gift', words: 'presents birthday', C: Gift },
  { key: 'house', label: 'House', words: 'home chores', C: House },
  { key: 'heart', label: 'Heart', words: 'love family', C: Heart },
  { key: 'baby', label: 'Baby', words: 'kids family', C: Baby },
  { key: 'dog', label: 'Dog', words: 'pet', C: Dog },
  { key: 'paw', label: 'Paw', words: 'pet animal', C: PawPrint },
  { key: 'stethoscope', label: 'Health', words: 'doctor medical', C: Stethoscope },
  { key: 'dumbbell', label: 'Fitness', words: 'gym workout exercise', C: Dumbbell },
  { key: 'utensils', label: 'Food', words: 'cooking recipes meals', C: Utensils },
  { key: 'coffee', label: 'Coffee', words: 'cafe morning', C: Coffee },
  { key: 'plane', label: 'Plane', words: 'travel trip flight', C: Plane },
  { key: 'car', label: 'Car', words: 'drive commute', C: Car },
  { key: 'map-pin', label: 'Place', words: 'map location travel', C: MapPin },
  { key: 'globe', label: 'Globe', words: 'world web travel', C: Globe },
  { key: 'leaf', label: 'Leaf', words: 'garden nature plants', C: Leaf },
  { key: 'sun', label: 'Sun', words: 'day weather morning', C: Sun },
  { key: 'moon', label: 'Moon', words: 'night evening sleep', C: Moon },
  { key: 'music', label: 'Music', words: 'songs audio', C: Music },
  { key: 'camera', label: 'Camera', words: 'photos', C: Camera },
  { key: 'film', label: 'Film', words: 'video movies', C: Film },
  { key: 'gamepad', label: 'Game', words: 'games play', C: Gamepad2 },
  { key: 'palette', label: 'Palette', words: 'art design', C: Palette },
  { key: 'sparkles', label: 'Sparkles', words: 'magic new ai', C: Sparkles },
  { key: 'star', label: 'Star', words: 'favourite important', C: Star },
  { key: 'zap', label: 'Lightning', words: 'fast energy urgent', C: Zap },
  { key: 'flame', label: 'Flame', words: 'hot fire urgent', C: Flame },
  { key: 'shield', label: 'Shield', words: 'security safety', C: Shield },
]

/** The six black-figure art icons (assets/brand/thread-icons). */
export const ART_ICONS = ['projects', 'work', 'errands', 'reading', 'inbox', 'general'] as const
export type ArtName = (typeof ART_ICONS)[number]
export const ART_LABEL: Record<ArtName, string> = {
  projects: 'Tools (art)',
  work: 'Work (art)',
  errands: 'Errands (art)',
  reading: 'Scroll (art)',
  inbox: 'Inbox (art)',
  general: 'General (art)',
}
const ART = new Set<string>(ART_ICONS)
const GLYPHS = new Map(THREAD_ICONS.map((i) => [i.key, i]))

export type ResolvedIcon = { kind: 'glyph'; icon: GlyphIcon } | { kind: 'art'; name: ArtName }

/** What to draw for a thread: a chosen glyph, chosen art (`art-<name>`), else the art for its id (else `general`). */
export function resolveThreadIcon(id: string, icon?: string): ResolvedIcon {
  if (icon) {
    const g = GLYPHS.get(icon)
    if (g) return { kind: 'glyph', icon: g }
    if (icon.startsWith('art-') && ART.has(icon.slice(4))) return { kind: 'art', name: icon.slice(4) as ArtName }
  }
  return { kind: 'art', name: (ART.has(id) ? id : 'general') as ArtName }
}

/** Icon picker filter: matches the label, key or keywords, case-insensitive. */
export function searchIcons(q: string): GlyphIcon[] {
  const s = q.trim().toLowerCase()
  if (!s) return [...THREAD_ICONS]
  return THREAD_ICONS.filter((i) => `${i.key} ${i.label} ${i.words}`.toLowerCase().includes(s))
}

/**
 * Bright highlight fills. Black ink (the brand's --talos-black) sits on every one at >= 6:1 (apps/web/test/threads/manage.test.ts),
 * and the roundel carries a black keyline, so a swatch reads on the cream list, the black sidebar and the dark theme alike.
 */
export const THREAD_COLOR: Record<ThreadColorKey, { hex: string; label: string }> = {
  red: { hex: '#ff6159', label: 'Red' },
  orange: { hex: '#ff8a1f', label: 'Orange' },
  yellow: { hex: '#ffd60a', label: 'Yellow' },
  lime: { hex: '#a8e630', label: 'Lime' },
  mint: { hex: '#3ee6b0', label: 'Mint' },
  cyan: { hex: '#2fd6f5', label: 'Cyan' },
  blue: { hex: '#5eabff', label: 'Blue' },
  violet: { hex: '#b48cff', label: 'Violet' },
  magenta: { hex: '#ef6bff', label: 'Magenta' },
  pink: { hex: '#ff5fa8', label: 'Hot pink' },
}
export const INK = '#141110'

export function threadColorHex(color?: string): string | undefined {
  return color && Object.hasOwn(THREAD_COLOR, color) ? THREAD_COLOR[color as ThreadColorKey].hex : undefined
}

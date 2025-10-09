// app/(tabs)/index.jsx
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, Image, InteractionManager, Keyboard, LayoutAnimation, Platform, Pressable, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import DatePickerSheet from '../../components/DatePickerSheet';
import GuestPicker from '../../components/GuestPicker';

import MenuIcon from '@/assets/icons/Menu.svg';
import NewIcon from '@/assets/icons/New.svg';
import Logo from '@/assets/images/Logo.svg';

const fullText = "Hi there! I'm your AI Travel Assistant";
const WELCOME_MESSAGE = { id: 'welcome-0', role: 'ai', text: "Hi! I'm your travel assistant - where would you like to go?" };
const CHAT_API_BASE = process.env.EXPO_PUBLIC_API_BASE ?? 'https://travelapi-34zi.onrender.com';
const CHAT_ENDPOINT = `${CHAT_API_BASE.replace(/\/$/, '')}/travel`;
const generateUniqueId = (role) => `${role}-${Date.now()}-${Math.random()}`;

async function callTravelBot(history) {
  const res = await fetch(CHAT_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: history }) });
  if (!res.ok) throw new Error('Network error');
  return res.json();
}
const isSamePlan = (a, b) => !!a && !!b && a.location === b.location && a.dateRange === b.dateRange && a.price === b.price;

const LoadingIndicator = () => {
  const [dots, setDots] = useState('.');
  useEffect(() => { const i = setInterval(() => { setDots(p => (p.length >= 3 ? '.' : p + '.')); }, 400); return () => clearInterval(i); }, []);
  return <View style={[styles.messageBubble, styles.aiBubble]}><Text style={styles.loadingText}>{dots}</Text></View>;
};

const FEATURE_CHIPS = [ { id: 'route', title: 'Smart Route', subtitle: 'Plan Your Journey', icon: 'navigate-outline', onPress: (h) => h.openSheetNow('date') }, { id: 'booking', title: 'Instant Booking', subtitle: 'All in One Place', icon: 'flash-outline', onPress: (h) => h.sendUser('Book me the best deal for my next trip.') }, { id: 'budget', title: 'Smart Budget', subtitle: 'Control Your Costs', icon: 'wallet-outline', onPress: (h) => h.openSheetNow('guests') }, { id: 'ideas', title: 'Trip Ideas', subtitle: 'Curated For You', icon: 'sparkles-outline', onPress: (h) => h.setMessages(p => [...p, { id: generateUniqueId('ai'), role: 'ai', text: 'Looking for inspiration? Paris, Kyoto, or Lisbon this season!' }]) }];
const FeatureChipsBar = ({ helpers }) => ( <View style={styles.chipsWrap} pointerEvents="box-none"> <FlatList data={FEATURE_CHIPS} keyExtractor={(i) => i.id} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsContent} ItemSeparatorComponent={() => <View style={{ width: 10 }} />} renderItem={({ item }) => ( <TouchableOpacity activeOpacity={0.9} onPress={() => item.onPress(helpers)} style={styles.chip}> <View style={styles.chipIcon}><Ionicons name={item.icon} size={16} color="#C8D1E5" /></View> <View style={{ flexShrink: 1 }}><Text style={styles.chipTitle}>{item.title}</Text><Text style={styles.chipSubtitle}>{item.subtitle}</Text></View> </TouchableOpacity> )} /> </View> );

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [displayed, setDisplayed] = useState('');
  const [deleting, setDeleting] = useState(false);
  const charIndex = useRef(0);
  const timeoutRef = useRef(null);

  useEffect(() => {
    const step = () => {
      if (!deleting) {
        if (charIndex.current < fullText.length) {
          setDisplayed(fullText.slice(0, ++charIndex.current));
          timeoutRef.current = setTimeout(step, 100);
        } else {
          timeoutRef.current = setTimeout(() => setDeleting(true), 1000);
        }
      } else {
        if (charIndex.current > 0) {
          setDisplayed(fullText.slice(0, --charIndex.current));
          timeoutRef.current = setTimeout(step, 50);
        } else {
          setDeleting(false);
          timeoutRef.current = setTimeout(step, 500);
        }
      }
    };
    step();
    return () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); };
  }, [deleting]);

  const [messages, setMessages] = useState([WELCOME_MESSAGE]);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showGuestPicker, setShowGuestPicker] = useState(false);
  const chatStarted = useMemo(() => messages.some((m) => m.role === 'user' || m.role === 'plan'), [messages]);
  const [inputValue, setInputValue] = useState('');
  const [focused, setFocused] = useState(false);
  const inputRef = useRef(null);
  const expanded = focused || inputValue.trim().length > 0;
  const translateY = useRef(new Animated.Value(0)).current;
  const flatListRef = useRef(null);
  const atBottomRef = useRef(true);
  const isDraggingRef = useRef(false);
  const BOTTOM_THRESHOLD = 40;

  const updateAtBottom = (e) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    atBottomRef.current = contentSize.height - (contentOffset.y + layoutMeasurement.height) < BOTTOM_THRESHOLD;
  };

  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, (e) => {
      const keyboardHeight = e?.endCoordinates?.height ?? 0;
      let translation = -keyboardHeight + 120;
      if (expanded) translation += 40;
      Animated.timing(translateY, { toValue: translation, duration: Platform.OS === 'ios' ? (e?.duration ?? 250) : 250, useNativeDriver: true }).start();
      setTimeout(() => { if (atBottomRef.current && !isDraggingRef.current) flatListRef.current?.scrollToEnd?.({ animated: true }); }, 100);
    });
    const hide = Keyboard.addListener(hideEvt, () => {
      Animated.timing(translateY, { toValue: 0, duration: 300, useNativeDriver: true }).start();
    });
    return () => { show.remove(); hide.remove(); };
  }, [translateY, expanded]);

  useEffect(() => {
    if (atBottomRef.current && !isDraggingRef.current) flatListRef.current?.scrollToEnd?.({ animated: true });
  }, [messages]);

  const inputHeight = useRef(new Animated.Value(56)).current;
  useEffect(() => {
    Animated.timing(inputHeight, { toValue: expanded ? 96 : 56, duration: 160, useNativeDriver: false }).start();
  }, [expanded, inputHeight]);

  const focusInput = () => { inputRef.current?.focus?.(); if (!focused) setFocused(true); };
  const collapseInput = () => { Keyboard.dismiss(); setFocused(false); };

  useEffect(() => {
    if (expanded) {
      const id = requestAnimationFrame(() => inputRef.current?.focus?.());
      return () => cancelAnimationFrame(id);
    }
  }, [expanded]);
  
  const openSheetNow = (type) => {
    Keyboard.dismiss();
    setTimeout(() => {
      if (type === 'date') setShowDatePicker(true);
      if (type === 'guests') setShowGuestPicker(true);
    }, Platform.OS === 'ios' ? 100 : 0);
  };

  const sendUser = async (text) => {
    const trimmed = (text || '').trim();
    if (!trimmed) return;

    const userMessage = { id: generateUniqueId('user'), role: 'user', text: trimmed };
    const loadingMessage = { id: generateUniqueId('loading'), role: 'ai', loading: true };

    // ✅ THE FIX: Build the history for the server *before* updating the state.
    // This captures the current state correctly.
    const historyForServer = [...messages.filter(m => m.role !== 'plan' && !m.loading), userMessage];

    // Update the UI immediately with the new user message and loading indicator.
    setMessages(prev => [...prev, userMessage, loadingMessage]);
    setInputValue('');
    collapseInput();

    try {
        const { aiText, signal } = await callTravelBot(historyForServer);

        // Process the response from the server.
        setMessages(prev => {
            const newMessages = prev.filter(m => m.id !== loadingMessage.id); // Remove loading indicator

            if (aiText) {
                newMessages.push({ id: generateUniqueId('ai'), role: 'ai', text: aiText });
            }

            if (signal?.type === 'planReady') {
                LayoutAnimation.easeInEaseOut();
                newMessages.push({ id: generateUniqueId('plan'), role: 'plan', payload: signal.payload });
                newMessages.push({ id: generateUniqueId('snapshot'), role: 'user', text: '[PLAN_SNAPSHOT]', hidden: true });
            }
            return newMessages;
        });
        
        // Handle signals that require opening a sheet.
        if (signal?.type === 'dateNeeded') openSheetNow('date');
        if (signal?.type === 'guestsNeeded') openSheetNow('guests');

    } catch (e) {
      console.error("Failed to send message:", e);
      // If the network call fails, replace the loading indicator with an error message.
      setMessages(prev => [...prev.filter(m => m.id !== loadingMessage.id), { id: generateUniqueId('ai-error'), role: 'ai', text: 'I couldn\'t reach the server. Try again?' }]);
    }
  };

  const onDatesSelected = ({ startDate, endDate }) => {
    setShowDatePicker(false);
    sendUser(`📅 I'd like to go from ${startDate} to ${endDate}`);
  };

  const onGuestSelected = ({ adults, children }) => {
    setShowGuestPicker(false);
    sendUser(`👤 We're ${adults} adult(s) and ${children} child(ren).`);
  };
  
  const getLocationText = (p = {}) => p.location || 'Your Trip';
  const formatPrice = (v) => { if (typeof v !== 'number') return v || ''; try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v); } catch { return `$${v.toFixed(2)}`; } };

  const PlanCard = ({ payload }) => {
    if (!payload) return null;
    const { description = '', image, price, weather = {} } = payload;
    const dates = payload.dateRange || '';
    const title = getLocationText(payload);
    const tempReadable = Number.isFinite(weather?.temp) ? `${weather.temp}°C` : null;
    const hasDetails = payload.itinerary && Array.isArray(payload.itinerary) && payload.itinerary.length > 0;
    
    return (
      <View style={styles.cardContainer}>
        <Image source={{ uri: image }} style={styles.cardImage} resizeMode="cover" />
        <View style={styles.cardContent}>
          <View style={styles.pcRowBetween}>
            <Text style={styles.pcTitle} numberOfLines={1}>{title}</Text>
            {tempReadable && <View style={styles.pcWeatherPill}><Ionicons name={weather?.icon ? `${weather.icon}-outline` : 'sunny-outline'} size={16} color="#FFD166" /><Text style={styles.pcWeatherText}>{tempReadable}</Text></View>}
          </View>
          {!!dates && <Text style={styles.pcDates}>{dates}</Text>}
          {!!description && <Text style={styles.pcDesc} numberOfLines={3}>{description}</Text>}
          {!!price && <Text style={styles.pcPriceLabel}>Total price:</Text>}
          {!!price && <Text style={styles.pcPriceValue}>{formatPrice(price)}</Text>}
          <View style={styles.pcActions}>
            <TouchableOpacity activeOpacity={0.9} style={styles.pcSquareBtn}><Ionicons name="share-outline" size={18} color="#AFC1D8" /></TouchableOpacity>
            <TouchableOpacity activeOpacity={0.9} style={styles.pcSquareBtn}><Ionicons name="heart-outline" size={18} color="#AFC1D8" /></TouchableOpacity>
            <TouchableOpacity activeOpacity={0.9} style={[styles.pcInfoBtn, !hasDetails && styles.pcInfoBtnDisabled]} disabled={!hasDetails} onPress={() => router.push({ pathname: '/TripDetails', params: { plan: JSON.stringify(payload) } })}>
              <Ionicons name="information-circle-outline" size={18} color="#C9D5E9" />
              <Text style={styles.pcInfoText}>Info</Text>
            </TouchableOpacity>
            <TouchableOpacity activeOpacity={0.95} style={styles.pcBuyBtn}><Text style={styles.pcBuyText}>Buy</Text></TouchableOpacity>
          </View>
        </View>
      </View>
    );
  };

  const renderMessage = ({ item }) => {
    if (item.hidden) return null;
    if (item.loading) return <LoadingIndicator />;
    if (item.role === 'plan') return <PlanCard payload={item.payload} />;
    return <View style={[styles.messageBubble, item.role === 'user' ? styles.userBubble : styles.aiBubble]}><Text style={styles.messageText}>{item.text}</Text></View>;
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right', 'bottom']}>
      <View style={[styles.topBarWrap, { paddingTop: (insets?.top ?? 0) + 44 }]}>
        <View style={styles.topBar}>
          <TouchableOpacity activeOpacity={0.8}><MenuIcon width={26} height={26} /></TouchableOpacity>
          <Text style={styles.topBarText}>Chat</Text>
          <TouchableOpacity activeOpacity={0.8} onPress={() => { Keyboard.dismiss(); setMessages([WELCOME_MESSAGE]); }}>
            <NewIcon width={24} height={24} />
          </TouchableOpacity>
        </View>
      </View>
      {!chatStarted && <View style={styles.header}><View style={{ marginBottom: 20 }}><Logo width={75} height={38} /></View><Text style={styles.title}>{displayed}</Text><Text style={styles.subtitle}>Where would you like to go today?</Text></View>}
      <Animated.View style={[styles.bottomArea, { transform: [{ translateY }] }]}>
        {focused && (<Pressable style={StyleSheet.absoluteFill} onPress={collapseInput} />)}
        {chatStarted && <View style={{ flex: 1 }}><FlatList ref={flatListRef} data={messages} keyExtractor={(item) => item.id} renderItem={renderMessage} contentContainerStyle={[styles.chatContent, { paddingBottom: expanded ? 120 : 80 }]} ListFooterComponent={<View style={{ height: 12 }} />} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} onScroll={updateAtBottom} onScrollBeginDrag={() => { isDraggingRef.current = true; }} onScrollEndDrag={() => { requestAnimationFrame(() => (isDraggingRef.current = false)); }} maintainVisibleContentPosition={{ minIndexForVisible: 0 }} /></View>}
        <FeatureChipsBar helpers={{ openSheetNow, sendUser, setMessages }} />
        <Animated.View style={[styles.inputContainer, { height: inputHeight, flexDirection: expanded ? 'column' : 'row', alignItems: expanded ? 'stretch' : 'center' }]} onStartShouldSetResponder={() => true} onResponderGrant={focusInput}>
          {!expanded ? (<><TouchableOpacity style={[styles.iconBtn, { marginRight: 8 }]} onPress={() => openSheetNow('date')}><Ionicons name="add" size={22} color="#fff" /></TouchableOpacity><TextInput ref={inputRef} placeholder="Plan your trip" placeholderTextColor="#aaa" value={inputValue} onChangeText={setInputValue} style={styles.inlineInput} multiline={false} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onSubmitEditing={() => sendUser(inputValue)} blurOnSubmit />{inputValue.trim().length === 0 ? (<TouchableOpacity style={[styles.iconBtn, { marginLeft: 8 }]}><Ionicons name="mic-outline" size={20} color="#fff" /></TouchableOpacity>) : (<TouchableOpacity style={[styles.iconBtn, styles.sendFilled, { marginLeft: 8 }]} onPress={() => sendUser(inputValue)}><Ionicons name="arrow-up" size={20} color="#fff" /></TouchableOpacity>)}</>) : (<><TextInput ref={inputRef} placeholder="Plan your trip" placeholderTextColor="#a0a0a0" value={inputValue} onChangeText={setInputValue} style={styles.textArea} multiline onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} /><View style={[styles.iconsRow, { marginTop: 8 }]} ><TouchableOpacity style={styles.iconBtn} onPress={() => openSheetNow('date')}><Ionicons name="add" size={22} color="#fff" /></TouchableOpacity>{expanded ? (<TouchableOpacity style={[styles.iconBtn, styles.sendFilled]} onPress={() => sendUser(inputValue)}><Ionicons name="arrow-up" size={20} color="#fff" /></TouchableOpacity>) : (<TouchableOpacity style={styles.iconBtn}><Ionicons name="mic-outline" size={20} color="#fff" /></TouchableOpacity>)}</View></>)}
        </Animated.View>
      </Animated.View>
      {showDatePicker && (<DatePickerSheet onClose={() => setShowDatePicker(false)} onDateSelected={onDatesSelected} />)}
      {showGuestPicker && (<GuestPicker onClose={() => setShowGuestPicker(false)} onGuestSelected={onGuestSelected} />)}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0E141C' },
    topBarWrap: { position: 'absolute', top: -40, left: 0, right: 0, zIndex: 30, backgroundColor: '#0E141C' },
    topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: -10 },
    topBarText: { color: 'white', fontSize: 18, fontWeight: '600' },
    header: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    title: { fontSize: 20, color: 'white', fontFamily: 'Raleway_700Bold', marginBottom: 10, textAlign: 'center', paddingHorizontal: 20 },
    subtitle: { fontSize: 18, color: 'rgba(255, 255, 255, 0.37)', fontFamily: 'Raleway_400Regular', textAlign: 'center', paddingHorizontal: 20 },
    bottomArea: { flex: 1, justifyContent: 'flex-end', paddingBottom: 120, paddingHorizontal: 20, position: 'relative' },
    chatContent: { padding: 16 },
    messageBubble: { maxWidth: '85%', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 14, marginVertical: 6 },
    userBubble: { alignSelf: 'flex-end', backgroundColor: '#1A2028' },
    aiBubble: { alignSelf: 'flex-start', backgroundColor: '#1E2A3A' },
    messageText: { color: '#fff', fontSize: 16, lineHeight: 20, fontFamily: 'Raleway_400Regular' },
    loadingText: { color: '#fff', fontSize: 20, fontWeight: 'bold' },
    cardContainer: { width: '100%', backgroundColor: '#0F1722', borderRadius: 16, overflow: 'hidden', marginVertical: 8, borderWidth: 1, borderColor: '#1E2A3A' },
    cardImage: { width: '100%', height: 150 },
    cardContent: { padding: 12 },
    pcRowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    pcTitle: { color: '#EAF2FF', fontSize: 18, fontWeight: '700', flexShrink: 1, paddingRight: 10 },
    pcWeatherPill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#132233', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: '#22354B' },
    pcWeatherText: { color: '#E6F0FF', fontSize: 12, fontWeight: '600' },
    pcDates: { color: '#94A3B8', marginTop: 4, marginBottom: 8, fontSize: 12 },
    pcDesc: { color: '#C9D5E9', fontSize: 13, lineHeight: 18 },
    pcPriceLabel: { color: '#94A3B8', marginTop: 10, fontSize: 12 },
    pcPriceValue: { color: '#EAF2FF', fontWeight: '800', fontSize: 20, marginTop: 2 },
    pcActions: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
    pcSquareBtn: { height: 36, width: 36, borderRadius: 10, backgroundColor: '#1B2636', borderWidth: 1, borderColor: '#27374B', alignItems: 'center', justifyContent: 'center' },
    pcInfoBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 36, borderRadius: 12, backgroundColor: '#1B2636', borderWidth: 1, borderColor: '#27374B' },
    pcInfoBtnDisabled: { opacity: 0.4 },
    pcInfoText: { color: '#C9D5E9', fontWeight: '700', fontSize: 13 },
    pcBuyBtn: { marginLeft: 'auto', paddingHorizontal: 18, height: 40, borderRadius: 14, backgroundColor: '#3E6FFF', alignItems: 'center', justifyContent: 'center' },
    pcBuyText: { color: '#fff', fontWeight: '800', fontSize: 15 },
    chipsWrap: { marginBottom: 10, zIndex: 15, position: 'relative' },
    chipsContent: { paddingHorizontal: 2 },
    chip: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#171E27', borderRadius: 18, paddingVertical: 10, paddingHorizontal: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: '#232C38' },
    chipIcon: { height: 24, width: 24, borderRadius: 12, marginRight: 10, backgroundColor: '#121821', alignItems: 'center', justifyContent: 'center' },
    chipTitle: { color: '#E8EDF7', fontSize: 16, fontFamily: 'Raleway_700Regular' },
    chipSubtitle: { color: '#a0a0a0', fontSize: 12, marginTop: 2, fontFamily: 'Raleway_700Regular' },
    inputContainer: { backgroundColor: '#1C222C', borderRadius: 14, paddingHorizontal: 10, paddingTop: 4, marginTop: 10, overflow: 'hidden', zIndex: 20 },
    inlineInput: { flex: 1, color: '#a0a0a0', paddingHorizontal: 8, paddingVertical: 10, fontSize: 16, maxHeight: 80, fontFamily: 'Raleway_700Regular' },
    textArea: { flex: 1, color: 'white', fontSize: 16, padding: 0, maxHeight: 140, fontFamily: 'Raleway_700Regular' },
    iconsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 8 },
    iconBtn: { height: 40, width: 40, borderRadius: 10, backgroundColor: '#1C222C', alignItems: 'center', justifyContent: 'center' },
    sendFilled: { backgroundColor: '#3E6FFF' },
});

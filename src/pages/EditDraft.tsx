import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Container,
  Alert,
  Snackbar,
  CircularProgress,
  Backdrop,
  Typography,
  Box,
  Button,
} from '@mui/material';
import { ArrowBack as ArrowBackIcon } from '@mui/icons-material';
import ArticleEditor from '../components/editor/ArticleEditor';
import AIResultReview from '../components/ai/AIResultReview';
import { useAppStore, useDraftStore, useAnalysisStore, useSuggestionStore, useStatsStore } from '../store';
import { analyzeSite, createPost } from '../services/wordpress';
import { generateArticleSuggestions } from '../services/gemini';
import { formatFullArticleToHTML, cleanupHTML } from '../utils/contentFormatter';
import { addPromptHistory, linkArticleToPromptHistory } from '../services/promptHistory';
import type { DraftArticle, WordPressCategory, WordPressTag, SiteAnalysis, PromptTemplate } from '../types';
import type { FileProcessingResult } from '../services/fileProcessor';

function EditDraft() {
  const navigate = useNavigate();
  const { draftId } = useParams<{ draftId: string }>();
  
  // Store hooks
  const { config, user } = useAppStore();
  const { getDraft, updateDraft } = useDraftStore();
  const { getAnalysis, setAnalysis } = useAnalysisStore();
  const { currentSuggestion, setSuggestion, setLoading, isLoading } = useSuggestionStore();
  const { incrementApiCall, incrementArticleCount } = useStatsStore();

  // Local state
  const [categories, setCategories] = useState<WordPressCategory[]>([]);
  const [tags, setTags] = useState<WordPressTag[]>([]);
  const [currentSiteAnalysis, setCurrentSiteAnalysis] = useState<SiteAnalysis | null>(null);
  const [alert, setAlert] = useState<{ message: string; severity: 'success' | 'error' | 'info' } | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [fileContent, setFileContent] = useState<FileProcessingResult | null>(null);
  
  // AI提案結果表示モード
  const [showAIResult, setShowAIResult] = useState(false);
  const [originalInput, setOriginalInput] = useState('');
  const [currentDraft, setCurrentDraft] = useState<Partial<DraftArticle> | null>(null);
  const [currentPromptHistoryId, setCurrentPromptHistoryId] = useState<string | null>(null);

  // 初期化処理
  useEffect(() => {
    const initializeEditor = async () => {
      if (!draftId) {
        setAlert({ message: '下書きIDが指定されていません。', severity: 'error' });
        return;
      }

      // 下書きデータを取得
      const draft = getDraft(draftId);
      if (!draft) {
        setAlert({ message: '指定された下書きが見つかりません。', severity: 'error' });
        setTimeout(() => navigate('/drafts'), 2000);
        return;
      }

      // 下書きデータをセット
      setCurrentDraft(draft);

      // ファイル情報を復元
      if (draft.fileMetadata) {
        try {
          const metadata = JSON.parse(draft.fileMetadata);
          setFileContent({
            filename: metadata.filename,
            content: {
              text: draft.originalInput || '',
              wordCount: metadata.wordCount || 0,
              headings: metadata.headings || [],
              keywords: metadata.keywords || [],
              structure: metadata.structure || '',
            },
          });
        } catch (error) {
          console.error('Failed to parse file metadata:', error);
        }
      }

      if (!config?.currentSiteId || !config.sites.length) {
        setAlert({ message: 'WordPressサイトが設定されていません。設定画面で追加してください。', severity: 'error' });
        return;
      }

      const currentSite = config.sites.find(site => site.id === config.currentSiteId);
      if (!currentSite) {
        setAlert({ message: '選択されたサイトが見つかりません。', severity: 'error' });
        return;
      }

      try {
        // キャッシュされた分析データを確認
        let analysis = getAnalysis(currentSite.id);
        
        if (!analysis || isAnalysisExpired(analysis)) {
          setAlert({ message: 'サイト分析を実行しています...', severity: 'info' });
          analysis = await analyzeSite(currentSite, { postCount: 20 });
          setAnalysis(currentSite.id, analysis);
        }

        setCurrentSiteAnalysis(analysis);
        setCategories(analysis.categories);
        setTags(analysis.tags);
        
        setAlert({ message: '下書きの編集準備が完了しました', severity: 'success' });
      } catch (error) {
        console.error('Site analysis failed:', error);
        setAlert({ message: 'サイト分析に失敗しました。サイト設定を確認してください。', severity: 'error' });
      }
    };

    initializeEditor();
  }, [draftId, config, getDraft, getAnalysis, setAnalysis, navigate]);

  const isAnalysisExpired = (analysis: SiteAnalysis): boolean => {
    const expireTime = 60 * 60 * 1000; // 1時間
    return Date.now() - new Date(analysis.analyzedAt).getTime() > expireTime;
  };

  // AI提案生成
  const handleGenerateAI = async (input: string, customPrompt?: string) => {
    if (!config?.geminiApiKey || !input.trim()) {
      setAlert({ message: 'Gemini APIキーが設定されていないか、入力内容が空です。', severity: 'error' });
      return;
    }

    const startTime = Date.now();

    try {
      setLoading(true);
      
      // 元の入力内容を保存
      setOriginalInput(input);
      
      // プロンプトテンプレートを作成
      let template: PromptTemplate | undefined = undefined;
      
      try {
        // カスタムプロンプトが提供された場合はそれを使用、そうでなければ設定から取得
        const systemPrompt = customPrompt || config.prompts?.system || '';
        
        if (systemPrompt && systemPrompt.trim()) {
          template = {
            id: 'user_system_prompt',
            name: 'システムプロンプト',
            system: systemPrompt,
            tone: 'professional' as const,
            targetAudience: 'ユーザー設定',
            seoFocus: 8,
            purpose: 'information' as const,
          };
          console.log('Using system prompt template:', template);
        } else {
          console.log('No system prompt found, using default AI behavior');
        }
      } catch (error) {
        console.error('Error creating prompt template:', error);
        setAlert({ message: 'プロンプトテンプレートの作成に失敗しました', severity: 'error' });
      }

      const suggestion = await generateArticleSuggestions(
        config.geminiApiKey,
        config.selectedModel,
        input,
        currentSiteAnalysis || undefined,
        template,
        fileContent ? {
          text: fileContent.content.text,
          headings: fileContent.content.headings,
          keywords: fileContent.content.keywords,
          structure: fileContent.content.structure,
        } : undefined
      );

      setSuggestion(suggestion);
      
      const processingTime = Date.now() - startTime;
      const tokensUsed = 2000; // 概算値
      const estimatedCost = 0.01; // 概算値
      
      // プロンプト履歴を保存
      const promptHistory = addPromptHistory({
        originalPrompt: input,
        userInput: input,
        fileInfo: fileContent ? {
          filename: fileContent.filename,
          fileSize: fileContent.content.text.length,
          wordCount: fileContent.content.wordCount,
        } : undefined,
        modelUsed: config.selectedModel,
        suggestion,
        processingTime,
        tokensUsed,
        estimatedCost,
        siteId: config.currentSiteId,
      });
      
      // プロンプト履歴IDを保存
      setCurrentPromptHistoryId(promptHistory.id);
      
      incrementApiCall(tokensUsed, estimatedCost);
      
      // AI提案を直接エディターに反映
      setShowAIResult(false); // AIResultReviewは表示しない
      setAlert({ message: 'AI提案を生成し、エディターに反映しました。内容を確認・編集してください。', severity: 'success' });
    } catch (error) {
      console.error('AI suggestion failed:', error);
      setAlert({ message: 'AI提案の生成に失敗しました。APIキーと通信状況を確認してください。', severity: 'error' });
    } finally {
      setLoading(false);
    }
  };

  // ファイル処理完了時の処理
  const handleFileProcessed = (result: FileProcessingResult) => {
    setFileContent(result);
    setAlert({ 
      message: `ファイル「${result.filename}」を処理しました（${result.content.wordCount}文字）`, 
      severity: 'success' 
    });
  };

  // ファイル処理エラー時の処理
  const handleFileError = (error: string) => {
    setAlert({ message: error, severity: 'error' });
  };

  // 下書き保存
  const handleSave = async (article: Partial<DraftArticle>) => {
    if (!config?.currentSiteId || !draftId) return;

    try {
      // 基本的な文字数計算
      const plainTextContent = article.content?.replace(/<[^>]*>/g, '') || '';
      const wordCount = plainTextContent.length;
      
      // AI提案に関連する情報を追加
      const enhancedDraftData: Partial<DraftArticle> = {
        ...article,
        
        // ファイル関連情報（既存のものを保持または更新）
        sourceFile: fileContent?.filename || currentDraft?.sourceFile,
        originalInput: originalInput || article.content || currentDraft?.originalInput,
        usedPrompt: currentSuggestion ? originalInput : currentDraft?.usedPrompt,
        fileMetadata: fileContent ? JSON.stringify({
          filename: fileContent.filename,
          fileSize: fileContent.content.text.length,
          wordCount: fileContent.content.wordCount,
          headings: fileContent.content.headings,
          keywords: fileContent.content.keywords,
        }) : currentDraft?.fileMetadata,
        
        // AI提案関連情報
        aiSuggestionId: currentPromptHistoryId || currentDraft?.aiSuggestionId,
        
        // 基本的なSEO情報
        wordCount,
        keywords: fileContent?.content.keywords || currentDraft?.keywords || [],
      };

      updateDraft(draftId, enhancedDraftData);
      
      // プロンプト履歴と記事を連携
      if (currentPromptHistoryId) {
        // DraftArticleの完全なオブジェクトを作成
        const draftWithMetadata: DraftArticle = {
          ...currentDraft,
          ...enhancedDraftData,
          id: draftId,
          siteId: config.currentSiteId,
          createdAt: currentDraft?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as DraftArticle;
        
        linkArticleToPromptHistory(draftWithMetadata, currentPromptHistoryId);
      }
      
      setAlert({ message: '下書きを保存しました', severity: 'success' });
    } catch (error) {
      console.error('Draft save failed:', error);
      setAlert({ message: '下書きの保存に失敗しました', severity: 'error' });
    }
  };

  // 記事公開
  const handlePublish = async (article: Partial<DraftArticle>) => {
    if (!config?.currentSiteId || !article.title || !article.content) {
      setAlert({ message: 'タイトルと本文は必須です', severity: 'error' });
      return;
    }

    const currentSite = config.sites.find(site => site.id === config.currentSiteId);
    if (!currentSite) {
      setAlert({ message: 'サイト情報が見つかりません', severity: 'error' });
      return;
    }

    try {
      setIsPublishing(true);

      const postData = {
        title: article.title,
        content: article.content,
        excerpt: article.metaDescription || '',
        categories: article.categories || [],
        tags: article.tags || [],
        status: 'publish' as const,
      };

      const publishedPost = await createPost(currentSite, postData);
      
      incrementArticleCount();
      setAlert({ message: `記事「${article.title}」を公開しました`, severity: 'success' });
      
      // 公開成功後は下書き一覧に移動
      setTimeout(() => {
        navigate('/drafts');
      }, 2000);
      
    } catch (error) {
      console.error('Publish failed:', error);
      setAlert({ message: '記事の公開に失敗しました。権限と接続状況を確認してください。', severity: 'error' });
    } finally {
      setIsPublishing(false);
    }
  };

  // 予約投稿
  const handleSchedulePublish = async (article: Partial<DraftArticle>, publishDate: Date) => {
    if (!config?.currentSiteId || !article.title || !article.content) {
      setAlert({ message: 'タイトルと本文は必須です', severity: 'error' });
      return;
    }

    const currentSite = config.sites.find(site => site.id === config.currentSiteId);
    if (!currentSite) {
      setAlert({ message: 'サイト情報が見つかりません', severity: 'error' });
      return;
    }

    try {
      setIsPublishing(true);

      const postData = {
        title: article.title,
        content: article.content,
        excerpt: article.metaDescription || '',
        categories: article.categories || [],
        tags: article.tags || [],
        status: 'future' as const,
        date: publishDate.toISOString(),
      };

      const scheduledPost = await createPost(currentSite, postData);
      
      incrementArticleCount();
      setAlert({ 
        message: `記事「${article.title}」を${publishDate.toLocaleString('ja-JP')}に予約投稿しました`, 
        severity: 'success' 
      });
      
      // 予約投稿成功後は下書き一覧に移動
      setTimeout(() => {
        navigate('/drafts');
      }, 2000);
      
    } catch (error) {
      console.error('Schedule publish failed:', error);
      setAlert({ message: '予約投稿の設定に失敗しました。権限と接続状況を確認してください。', severity: 'error' });
    } finally {
      setIsPublishing(false);
    }
  };

  // プレビュー機能
  const handlePreview = (article: Partial<DraftArticle>) => {
    // 新しいウィンドウでプレビューを開く
    const previewWindow = window.open('', '_blank');
    if (previewWindow) {
      previewWindow.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>${article.title || '無題の記事'}</title>
          <meta name="description" content="${article.metaDescription || ''}">
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              line-height: 1.6;
              max-width: 800px;
              margin: 0 auto;
              padding: 20px;
              color: #333;
            }
            h1, h2, h3, h4, h5, h6 {
              font-weight: 600;
              line-height: 1.3;
              margin: 1.5em 0 0.5em 0;
            }
            h1 { font-size: 2em; }
            h2 { font-size: 1.5em; border-bottom: 2px solid #eee; padding-bottom: 0.3em; }
            h3 { font-size: 1.25em; }
            p { margin: 0 0 1em 0; }
            img { max-width: 100%; height: auto; }
            blockquote {
              border-left: 4px solid #ddd;
              margin: 1em 0;
              padding: 0.5em 1em;
              font-style: italic;
              background: #f9f9f9;
            }
            code {
              background: #f4f4f4;
              padding: 0.2em 0.4em;
              border-radius: 3px;
              font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
            }
            pre {
              background: #f4f4f4;
              padding: 1em;
              border-radius: 3px;
              overflow-x: auto;
            }
            .meta {
              background: #f8f9fa;
              padding: 1em;
              border-radius: 5px;
              margin-bottom: 2em;
              border-left: 4px solid #007cba;
            }
            .preview-note {
              background: #fff3cd;
              border: 1px solid #ffeaa7;
              padding: 10px;
              border-radius: 5px;
              margin-bottom: 20px;
              text-align: center;
              font-size: 0.9em;
            }
          </style>
        </head>
        <body>
          <div class="preview-note">
            📝 これは記事のプレビューです。実際の公開時とは表示が異なる場合があります。
          </div>
          <div class="meta">
            <strong>メタディスクリプション:</strong><br>
            ${article.metaDescription || '（設定されていません）'}
          </div>
          <h1>${article.title || '無題の記事'}</h1>
          <div>${article.content || '（本文が入力されていません）'}</div>
        </body>
        </html>
      `);
    }
  };

  // AI提案採用処理
  const handleAdoptSuggestion = () => {
    if (!currentSuggestion) return;

    // 提案内容を記事データに変換
    const suggestedTitle = currentSuggestion.titles[0] || '';
    const suggestedMetaDescription = currentSuggestion.metaDescriptions[0] || '';
    
    // AI提案を構造化されたHTMLに変換
    let suggestedContent = '';
    if (currentSuggestion.fullArticle) {
      // HTMLフォーマッターを使用して適切な構造化を行う
      const formattedHTML = formatFullArticleToHTML(currentSuggestion);
      suggestedContent = cleanupHTML(formattedHTML);
    }

    // 下書きデータを作成
    const draftData: Partial<DraftArticle> = {
      title: suggestedTitle,
      content: suggestedContent,
      metaDescription: suggestedMetaDescription,
      categories: [...currentSuggestion.categories.existing],
      tags: [...currentSuggestion.tags.existing],
      status: 'ready_to_publish',
    };

    setCurrentDraft({...currentDraft, ...draftData});
    setShowAIResult(false);
    setAlert({ message: 'AI提案を採用しました。内容を確認して投稿してください。', severity: 'success' });
  };

  // 手動編集モードに切り替え
  const handleEditManually = () => {
    if (!currentSuggestion) return;

    // 部分的に提案内容を採用（ユーザーが編集可能な状態で）
    const suggestedTitle = currentSuggestion.titles[0] || '';
    
    // AI提案を構造化されたHTMLに変換（手動編集用）
    let suggestedContent = '';
    if (currentSuggestion.fullArticle) {
      const formattedHTML = formatFullArticleToHTML(currentSuggestion);
      suggestedContent = cleanupHTML(formattedHTML);
    }

    const draftData: Partial<DraftArticle> = {
      title: suggestedTitle,
      content: suggestedContent,
      metaDescription: currentSuggestion.metaDescriptions[0] || '',
      categories: [...currentSuggestion.categories.existing],
      tags: [...currentSuggestion.tags.existing],
      status: 'draft',
    };

    setCurrentDraft({...currentDraft, ...draftData});
    setShowAIResult(false);
    setAlert({ message: '編集モードに切り替えました。内容を自由に編集できます。', severity: 'info' });
  };

  // 新しいプロンプトで再提案
  const handleRegenerateWithPrompt = async (newPrompt: string) => {
    const inputWithPrompt = `${originalInput}\n\n追加指示: ${newPrompt}`;
    await handleGenerateAI(inputWithPrompt);
  };

  // AI結果表示をキャンセル
  const handleCancelAIResult = () => {
    setShowAIResult(false);
    setOriginalInput('');
    setSuggestion(null);
    setCurrentPromptHistoryId(null);
    setAlert({ message: 'AI提案をキャンセルしました。', severity: 'info' });
  };

  const closeAlert = () => {
    setAlert(null);
  };

  const handleBackToDrafts = () => {
    navigate('/drafts');
  };

  if (!config) {
    return (
      <Container>
        <Alert severity="error">
          アプリケーションの初期化に失敗しました。ページを再読み込みしてください。
        </Alert>
      </Container>
    );
  }

  if (!currentDraft) {
    return (
      <Container>
        <Alert severity="info">
          下書きを読み込み中...
        </Alert>
      </Container>
    );
  }

  return (
    <Container maxWidth="xl" sx={{ py: 2 }}>
      {/* ローディングオーバーレイ */}
      <Backdrop
        sx={{ color: '#fff', zIndex: (theme) => theme.zIndex.drawer + 1 }}
        open={isLoading || isPublishing}
      >
        <CircularProgress color="inherit" />
      </Backdrop>

      {/* ヘッダー */}
      <Box sx={{ mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
          <Button
            startIcon={<ArrowBackIcon />}
            onClick={handleBackToDrafts}
            variant="outlined"
          >
            下書き一覧に戻る
          </Button>
          <Typography variant="h4" component="h1">
            下書き編集: {currentDraft.title || '無題の記事'}
          </Typography>
        </Box>
      </Box>

      {/* 条件付きレンダリング: AI提案結果表示 vs 通常エディタ */}
      {showAIResult && currentSuggestion ? (
        <AIResultReview
          originalInput={originalInput}
          fileContent={fileContent}
          suggestion={currentSuggestion}
          categories={categories}
          tags={tags}
          onAdoptSuggestion={handleAdoptSuggestion}
          onEditManually={handleEditManually}
          onRegenerateWithPrompt={handleRegenerateWithPrompt}
          onCancel={handleCancelAIResult}
          isLoading={isLoading}
        />
      ) : (
        <ArticleEditor
          draft={currentDraft}
          categories={categories}
          tags={tags}
          suggestion={currentSuggestion}
          onSave={handleSave}
          onPublish={handlePublish}
          onSchedulePublish={handleSchedulePublish}
          onPreview={handlePreview}
          onGenerateAI={handleGenerateAI}
          onFileProcessed={handleFileProcessed}
          onFileError={handleFileError}
          isLoading={isLoading || isPublishing}
          fileContent={fileContent}
          autoApplyNewSuggestion={true}
        />
      )}

      {/* アラート表示 */}
      <Snackbar
        open={!!alert}
        autoHideDuration={alert?.severity === 'error' ? null : 6000}
        onClose={closeAlert}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        {alert && (
          <Alert onClose={closeAlert} severity={alert.severity} sx={{ width: '100%' }}>
            {alert.message}
          </Alert>
        )}
      </Snackbar>
    </Container>
  );
}

export default EditDraft;